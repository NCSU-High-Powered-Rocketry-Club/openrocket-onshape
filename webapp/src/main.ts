/**
 * Main UI entry point for the OpenRocket → Onshape converter.
 *
 * Flow:
 *  1. User drops/selects an .ork file
 *  2. Parser unzips + parses the XML → RocketJson
 *  3. Derived geometry is computed (profiles, planforms, masses)
 *  4. Validation warnings are shown and JSON is displayed/downloadable
 */

import { parseOrkFile } from './parser';
import { computeDerivedData } from './geometry';
import { validateRocketJson } from './validation';
import { getAutoDownloadPreference, setAutoDownloadPreference, shouldAutoDownload } from './storage';
import type { RocketJson, WarningDetail } from './types';

// ---------- DOM references ----------

const dropZone = document.getElementById('dropZone') as HTMLDivElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const summaryCard = document.getElementById('summaryCard') as HTMLElement;
const summaryGrid = document.getElementById('summaryGrid') as HTMLElement;
const cpPicker = document.getElementById('cpPicker') as HTMLElement;
const cpSourceSelect = document.getElementById('cpSourceSelect') as HTMLSelectElement;
const warningsCard = document.getElementById('warningsCard') as HTMLElement;
const warningList = document.getElementById('warningList') as HTMLElement;
const outputCard = document.getElementById('outputCard') as HTMLElement;
const jsonOutput = document.getElementById('jsonOutput') as HTMLPreElement;
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
const autoDownloadInput = document.getElementById('autoDownloadInput') as HTMLInputElement;

let currentJson: RocketJson | null = null;
let currentOrkBaseName = '';
/** The file's bytes, kept so a different CP source can be re-parsed without a re-pick. */
let currentBuffer: ArrayBuffer | null = null;
/** Index into `centerOfPressureBranches` that the user picked. */
let cpBranchIndex = 0;

// ---------- File handling ----------

function handleFile(file: File) {
  if (!file.name.toLowerCase().endsWith('.ork')) {
    alert('Please select an .ork file (OpenRocket design).');
    return;
  }

  currentOrkBaseName = file.name.replace(/\.ork$/i, '');
  currentBuffer = null;
  cpBranchIndex = 0;

  file.arrayBuffer()
    .then((buffer) => {
      currentBuffer = buffer;
      return rebuild();
    })
    .catch((err) => {
      alert(`Failed to parse .ork file:\n${err.message}`);
    });
}

/**
 * Re-run parse -> geometry -> validation and repaint everything. Runs once per
 * file load and again whenever the user picks a different CP source, so the
 * downloaded JSON always reflects the current selection. The FeatureScript
 * reads a single `centerOfPressure`, so resolving the choice here is all the
 * Onshape side ever needs.
 */
async function rebuild(): Promise<void> {
  if (!currentBuffer) return;
  const json = await parseOrkFile(currentBuffer, { centerOfPressureBranch: cpBranchIndex });
  computeDerivedData(json);
  validateRocketJson(json);
  currentJson = json;
  renderSummary(json);
  renderCpPicker(json);
  renderWarnings(json.warningDetails ?? []);
  renderJson(json);
  summaryCard.classList.remove('hidden');
  warningsCard.classList.remove('hidden');
  outputCard.classList.remove('hidden');
  if (autoDownloadInput.checked && shouldAutoDownload(json.warningDetails ?? [])) downloadJson();
}

// ---------- Rendering ----------

function countComponents(components: RocketJson['rocket']['components']): number {
  let count = 0;
  const visit = (comps: RocketJson['rocket']['components']) => {
    for (const c of comps) {
      count++;
      visit(c.children);
    }
  };
  visit(components);
  return count;
}

function renderSummary(json: RocketJson) {
  const r = json.rocket;
  const totalMass = sumMass(r.components);
  const source = r.centerOfPressureBranches?.[r.centerOfPressureSource ?? 0];
  const items: Array<[string, string]> = [
    ['Name', r.name],
    ['Designer', r.designer || '—'],
    ['Design Type', r.designType],
    ['Reference', r.referenceType],
    ['Components', String(countComponents(r.components))],
    ['Total Mass', totalMass > 0 ? `${(totalMass * 1000).toFixed(1)} g` : '—'],
    ['Center of Pressure', r.centerOfPressure === undefined ? '—' : `${(r.centerOfPressure * 1000).toFixed(1)} mm`],
    ['CP Source', source ? `${source.simulation}${source.branch ? ' — ' + source.branch : ''}` : '—'],
    ['Warnings', String(json.warnings.length)],
  ];

  summaryGrid.innerHTML = items
    .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
}

/** One option per saved simulation branch, so the user can pick the CP source. */
function renderCpPicker(json: RocketJson): void {
  const branches = json.rocket.centerOfPressureBranches ?? [];
  if (branches.length === 0) {
    cpPicker.classList.add('hidden');
    return;
  }
  cpPicker.classList.remove('hidden');

  const selected = json.rocket.centerOfPressureSource ?? 0;
  cpSourceSelect.replaceChildren(
    ...branches.map((b, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.selected = i === selected;
      const stage = b.branch ? ` — ${b.branch}` : '';
      const dropped = b.machFiltered ? `, ${b.apogeeSamples} post-apogee dropped` : '';
      option.textContent =
        `${b.simulation}${stage} — ${(b.median * 1000).toFixed(1)} mm (n=${b.count}${dropped})`;
      return option;
    })
  );
}

function sumMass(components: RocketJson['rocket']['components']): number {
  let total = 0;
  const visit = (comps: RocketJson['rocket']['components']) => {
    for (const c of comps) {
      if (typeof c.mass === 'number') total += c.mass;
      visit(c.children);
    }
  };
  visit(components);
  return total;
}

function renderJson(json: RocketJson) {
  jsonOutput.textContent = JSON.stringify(json, null, 2);
}

function renderWarnings(warnings: WarningDetail[]) {
  warningList.replaceChildren();
  const severityRank: Record<WarningDetail['severity'], number> = {
    error: 0, high: 1, medium: 2, low: 3, info: 4,
  };
  const ranked = [...warnings].sort((a, b) => {
    const severity = severityRank[a.severity] - severityRank[b.severity];
    return severity || a.message.localeCompare(b.message);
  });
  for (const warning of ranked) {
    const item = document.createElement('li');
    item.className = `warning warning-${warning.severity}`;
    const severity = document.createElement('strong');
    severity.textContent = warning.severity.toUpperCase();
    const message = document.createElement('span');
    message.textContent = warning.message;
    item.append(severity, message);
    warningList.append(item);
  }
}

// ---------- Download ----------

async function loadAutoDownloadPreference() {
  autoDownloadInput.checked = await getAutoDownloadPreference();
}

autoDownloadInput.addEventListener('change', () => {
  void setAutoDownloadPreference(autoDownloadInput.checked);
});

function downloadJson() {
  if (!currentJson) return;
  const blob = new Blob([JSON.stringify(currentJson, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const rocketName = currentJson.rocket.name.trim();
  const downloadBaseName = !rocketName || rocketName.toLowerCase() === 'rocket'
    ? currentOrkBaseName
    : rocketName;
  a.download = `${downloadBaseName.replace(/[^a-z0-9]+/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Event wiring ----------

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragging');
  dropZone.style.borderColor = 'var(--onshape)';
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragging');
  dropZone.style.borderColor = 'var(--border)';
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  dropZone.style.borderColor = 'var(--border)';
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

downloadBtn.addEventListener('click', downloadJson);

// Re-parse with the newly chosen CP source. Re-parsing (rather than patching
// the JSON) keeps the parser as the single source of truth for the marker.
cpSourceSelect.addEventListener('change', () => {
  cpBranchIndex = Number(cpSourceSelect.value) || 0;
  rebuild().catch((err) => {
    alert(`Failed to update the center of pressure:\n${err.message}`);
  });
});

void loadAutoDownloadPreference();