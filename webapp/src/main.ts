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
import type { RocketJson, RocketMotorConfiguration, WarningDetail } from './types';

// ---------- DOM references ----------

const dropZone = document.getElementById('dropZone') as HTMLDivElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const summaryCard = document.getElementById('summaryCard') as HTMLElement;
const summaryGrid = document.getElementById('summaryGrid') as HTMLElement;
const cpPicker = document.getElementById('cpPicker') as HTMLElement;
const cpSourceSelect = document.getElementById('cpSourceSelect') as HTMLSelectElement;
const motorPicker = document.getElementById('motorPicker') as HTMLElement;
const motorConfigSelect = document.getElementById('motorConfigSelect') as HTMLSelectElement;
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
/**
 * `configId` of the flight configuration the user picked, or '' for the file's
 * default. It is a configId rather than an index because the parser resolves
 * every motor mount against one, and a configId survives a re-parse that finds
 * the configurations in a different order.
 */
let motorConfigId = '';

// ---------- File handling ----------

function handleFile(file: File) {
  if (!file.name.toLowerCase().endsWith('.ork')) {
    alert('Please select an .ork file (OpenRocket design).');
    return;
  }

  currentOrkBaseName = file.name.replace(/\.ork$/i, '');
  currentBuffer = null;
  cpBranchIndex = 0;
  motorConfigId = '';

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
 * file load and again whenever the user picks a different CP source or motor
 * configuration, so the downloaded JSON always reflects the current selection.
 * The FeatureScript reads a single `centerOfPressure` and one motor per mount,
 * so resolving both choices here is all the Onshape side ever needs.
 */
async function rebuild(): Promise<void> {
  if (!currentBuffer) return;
  const json = await parseOrkFile(currentBuffer, {
    centerOfPressureBranch: cpBranchIndex,
    ...(motorConfigId ? { motorConfiguration: motorConfigId } : {}),
  });
  computeDerivedData(json);
  validateRocketJson(json);
  currentJson = json;
  // Adopt whatever the parser actually resolved, so the dropdown shows the
  // file's default after a load and the user's pick after a switch -- and a
  // configId the file does not declare falls back visibly rather than sticking.
  motorConfigId = json.rocket.motorConfigurationSource ?? '';
  renderSummary(json);
  renderCpPicker(json);
  renderMotorPicker(json);
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
  const configs = r.motorConfigurations ?? [];
  const configIndex = configs.findIndex((c) => c.configId === r.motorConfigurationSource);
  const motors = configIndex >= 0 ? motorsForConfig(r.components, r.motorConfigurationSource ?? '') : [];
  const items: Array<[string, string]> = [
    ['Name', r.name],
    ['Designer', r.designer || '—'],
    ['Design Type', r.designType],
    ['Reference', r.referenceType],
    ['Components', String(countComponents(r.components))],
    ['Total Mass', totalMass > 0 ? `${(totalMass * 1000).toFixed(1)} g` : '—'],
    ['Center of Pressure', r.centerOfPressure === undefined ? '—' : `${(r.centerOfPressure * 1000).toFixed(1)} mm`],
    ['CP Source', source ? `${source.simulation}${source.branch ? ' — ' + source.branch : ''}` : '—'],
    // Only when the file actually defines configurations, so a single-motor
    // rocket does not grow two rows of dashes.
    ...(configs.length > 0
      ? ([
          ['Motor Configuration', configIndex >= 0 ? motorConfigLabel(configs[configIndex], configIndex) : '—'],
          ['Motors', motors.length > 0 ? motors.join(', ') : '—'],
        ] as Array<[string, string]>)
      : []),
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

/**
 * Human label for one configuration: its name when the designer gave it one,
 * else "Configuration N" by position, plus "(default)" so the file's own
 * choice stays visible no matter which entry is selected.
 */
function motorConfigLabel(config: RocketMotorConfiguration, index: number): string {
  const base = config.name || `Configuration ${index + 1}`;
  return config.isDefault ? `${base} (default)` : base;
}

/**
 * The motor designations a configuration loads, gathered across every mount.
 *
 * Walks the parsed tree rather than re-reading the XML: the parser has already
 * resolved every mount's candidate list, and one configuration usually spans
 * more than one mount on a multi-stage rocket. Mounts that load nothing in this
 * configuration are skipped -- that is the "booster parked" case, and showing an
 * empty slot for it would only suggest something is missing.
 */
function motorsForConfig(components: RocketJson['rocket']['components'], configId: string): string[] {
  const found: string[] = [];
  const visit = (comps: RocketJson['rocket']['components']) => {
    for (const c of comps) {
      const mount = (c.params as { motorMount?: { configurations?: Array<{ configId: string; designation: string }> } })
        ?.motorMount;
      const match = mount?.configurations?.find((m) => m.configId === configId);
      if (match?.designation) found.push(match.designation);
      visit(c.children);
    }
  };
  visit(components);
  return [...new Set(found)];
}

/** One option per flight configuration, so the user can pick the motors to build. */
function renderMotorPicker(json: RocketJson): void {
  const configs = json.rocket.motorConfigurations ?? [];
  // A single configuration is nothing to choose between; showing a one-option
  // dropdown would just be noise.
  if (configs.length < 2) {
    motorPicker.classList.add('hidden');
    return;
  }
  motorPicker.classList.remove('hidden');

  const selected = json.rocket.motorConfigurationSource ?? '';
  motorConfigSelect.replaceChildren(
    ...configs.map((c, i) => {
      const option = document.createElement('option');
      option.value = c.configId;
      option.selected = c.configId === selected;
      const motors = motorsForConfig(json.rocket.components, c.configId);
      const loaded = motors.length > 0 ? ` — ${motors.join(', ')}` : ' — no motors';
      option.textContent = `${motorConfigLabel(c, i)}${loaded}`;
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

// Re-parse with the newly chosen motor configuration, for the same reason: the
// choice reaches every motor mount and the geometry derived from them, so
// patching one `motorMount` block would leave the rest of the payload stale.
motorConfigSelect.addEventListener('change', () => {
  motorConfigId = motorConfigSelect.value;
  rebuild().catch((err) => {
    alert(`Failed to update the motor configuration:\n${err.message}`);
  });
});

void loadAutoDownloadPreference();