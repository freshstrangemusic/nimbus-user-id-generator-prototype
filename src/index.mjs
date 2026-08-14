/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { $ } from "https://code.jquery.com/jquery-4.0.0.module.js";

import { Sampling } from "./sampling.mjs";

let environment = "production";

const V6_URLS = new Map([
  ["production", "https://experimenter.services.mozilla.com/api/v6/experiments/"],
  ["staging", "https://stage.experimenter.nonprod.webservices.mozgcp.net/api/v6/experiments/"],
]);

const metadata = new Map();

async function fetchRecipe(slug) {
  let rsp;
  try {
    rsp = await fetch(`${V6_URLS.get(environment)}${slug}/`);
  } catch (e) {
    console.log(e);
    alert("Could not fetch: check console log");
    return null;
  }

  switch (rsp.status) {
    case 200:
      break;

    case 404:
      alert("slug not found");
      return null;

    default:
      console.log("unexpected response", rsp);
      alert("unexpected response: check console log");
      return null;
  }

  let json
  try {
    json = await rsp.json();
  } catch (e) {
    console.log("response not json", rsp);
    alert("response not json: check console log");
    return null;
  }

  return json;
}

function branchSelectOptions(branches) {
  return branches.map(({ slug }) =>
    $(`<option class="branch"></option>`)
      .val(slug)
      .text(slug)
  );
}

function newSlugRow($slugRows) {
  const $row = $(`
    <tr>
      <td>
        <input type="text" placeholder="slug" class="slug-input">
      </td>
      <td>
        <button class="slug-lookup-btn">🔍</button>
      </td>
      <td>
        <select class="branch-select" disabled>
          <option value="">(not enrolled)</option>
          <option value="*">(any branch)</option>
        </select>
      </td>
      <td>
        <button class="remove-slug-btn">-</button>
      </td>
    </tr>
  `);

  const $slugInput = $row.find(".slug-input");
  const $branchSelect = $row.find(".branch-select");

  $row.find(".remove-slug-btn").click(e => {
    e.preventDefault();

    metadata.delete($row[0]);

    $row.remove();

    updateComputeBtnDisabled();
  });

  $row.find(".slug-lookup-btn").click(async e => {
    e.preventDefault();

    metadata.set($row[0], null);
    updateComputeBtnDisabled();

    $branchSelect.find(".branch").remove();
    $branchSelect[0].disabled = true;

    const slug = $slugInput.val().trim();
    if (!slug) {
      alert("invalid slug");
      return;
    }

    const recipe = await fetchRecipe(slug);
    if (!recipe) {
      return;
    }

    for (const entry of metadata.values()) {
      if (!entry) {
        continue;
      }

      if (slug === entry.slug) {
        alert("duplicate slug");
        return;
      }
    }

    const branchRatios = recipe.branches.map(branch => [branch.slug, branch.ratio]);

    $branchSelect.append(branchSelectOptions(recipe.branches));
    $branchSelect[0].disabled = false;

    metadata.set($row[0], {
      slug,
      branchRatios,
      selectedBranch: "",
      bucketConfig: recipe.bucketConfig
    });

    updateComputeBtnDisabled();
  });

  $row.find(".branch-select").change((e) => {
    metadata.get($row[0]).selectedBranch = $(e.target).val();
  });

  metadata.set($row[0], null);
  $slugRows.append($row);
}

function updateComputeBtnDisabled() {
  $("#id-compute-user-id").prop(
    "disabled",
    metadata.size === 0 || Array.from(metadata.values()).some(value => value === null)
  );
}

/* Based on the implementation of ExperimentManager.chooseBranch:
 * https://raw.githubusercontent.com/mozilla-firefox/firefox/25d7109bf565c299435dec3dd2b9e79a1ce7c15d/toolkit/components/nimbus/lib/ExperimentManager.sys.mjs
 */
async function chooseBranch(slug, branchRatios, id) {
  const ratios = branchRatios.map(([, ratio]) => ratio);
  const input = `experimentmanager-${id}-${slug}-branch`;

  const index = await Sampling.ratioSample(input, ratios);
  return branchRatios[index][0];
}

/* Based on the implementation of ExperimentManager.generateTestIds:
 * https://raw.githubusercontent.com/mozilla-firefox/firefox/25d7109bf565c299435dec3dd2b9e79a1ce7c15d/toolkit/components/nimbus/lib/ExperimentManager.sys.mjs
 */
async function computeId() {
  for (const { slug, selectedBranch, bucketConfig } of metadata.values()) {
    if (selectedBranch === "" && bucketConfig.count === bucketConfig.total) {
      alert(`${slug} will always enroll - pick a branch`);
      return null;
    } else if (selectedBranch !== "" && bucketConfig.count === 0) {
      alert(`${slug} will never enroll`); l
      return null;
    }
  }

  newId: while (true) {
    const id = crypto.randomUUID();

    for (const { slug, branchRatios, selectedBranch, bucketConfig } of metadata.values()) {
      const wouldEnroll = await Sampling.bucketSample(
        [id, bucketConfig.namespace],
        bucketConfig.start,
        bucketConfig.count,
        bucketConfig.total,
      );

      console.log(wouldEnroll, selectedBranch);

      if (wouldEnroll && selectedBranch === "") {
        continue newId;
      }

      if (!wouldEnroll && selectedBranch !== "") {
        continue newId;
      }

      if (!wouldEnroll && selectedBranch === "") {
        continue;
      }

      if (wouldEnroll && selectedBranch === "*") {
        continue;
      }

      const enrolledBranch = await chooseBranch(slug, branchRatios, id);

      if (enrolledBranch !== selectedBranch) {
        continue newId;
      }
    }

    return id;
  }
}

$(() => {
  const $slugsTable = $("#id-slugs-table");
  const $slugRows = $slugsTable.find("tbody");

  $("#id-environment")
    .val("production")
    .click(e => {
      e.preventDefault();

      environment = $(e.target).val();

      for (const row of metadata) {
        $(row).remove();
      }

      metadata.clear();

      newSlugRow($slugRows);
    });

  $("#id-add-slug-btn").click(e => {
    e.preventDefault();

    newSlugRow($slugRows);
  });

  const $computeBtn = $("#id-compute-user-id");
  $computeBtn.click(async e => {
    e.preventDefault();

    const $controls = $slugRows.find("input,button,select");

    $computeBtn.prop("disabled", true);
    $controls.prop("disabled", true);

    const $display = $("#id-display");

    const id = await computeId();
    if (id !== null) {
      $display.text(id);
    } else {
      $display.text("");
    }

    $computeBtn.prop("disabled", false);
    $controls.prop("disabled", false);
  });

  newSlugRow($slugRows);

  $("#id-app").show();
});
