/**
 * Main UI entry point for the OpenRocket → Onshape converter.
 *
 * Flow:
 *  1. User drops/selects an .ork file
 *  2. Parser unzips + parses the XML → RocketJson
 *  3. Derived geometry is computed (profiles, planforms, masses)
 *  4. JSON is displayed and downloadable
 *  5. User can optionally upload to Onshape with a bearer token
 */

import { parseOrkFile } from './parser';
import { computeDerivedData } from './geometry';
import { uploadRocketToOnshape } from './onshape';
import type { RocketJson } from './types';

// ---------- DOM references ----------

const dropZone = document.getElementById('dropZone') as HTMLDivElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const summaryCard = document.getElementById('summaryCard') as HTMLElement;
const summaryGrid = document.getElementById('summaryGrid') as HTMLElement;
const outputCard = document.getElementById('outputCard') as HTMLElement;
const jsonOutput = document.getElementById('jsonOutput') as HTMLPreElement;
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
const onshapeCard = document.getElementById('onshapeCard') as HTMLElement;
const tokenInput = document.getElementById('tokenInput') as HTMLInputElement;
const uploadBtn = document.getElementById('uploadBtn') as HTMLButtonElement;
const uploadStatus = document.getElementById('uploadStatus') as HTMLElement;

let currentJson: RocketJson | null = null;

// ---------- File handling ----------

function handleFile(file: File) {
  if (!file.name.toLowerCase().endsWith('.ork')) {
    alert('Please select an .ork file (OpenRocket design).');
    return;
  }

  file.arrayBuffer()
    .then(parseOrkFile)
    .then((json) => {
      computeDerivedData(json);
      currentJson = json;
      renderSummary(json);
      renderJson(json);
      summaryCard.classList.remove('hidden');
      outputCard.classList.remove('hidden');
      onshapeCard.classList.remove('hidden');
    })
    .catch((err) => {
      alert(`Failed to parse .ork file:\n${err.message}`);
    });
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
  const items: Array<[string, string]> = [
    ['Name', r.name],
    ['Designer', r.designer || '—'],
    ['Design Type', r.designType],
    ['Reference', r.referenceType],
    ['Components', String(countComponents(r.components))],
    ['Total Mass', totalMass > 0 ? `${(totalMass * 1000).toFixed(1)} g` : '—'],
    ['Warnings', String(json.warnings.length)],
  ];

  summaryGrid.innerHTML = items
    .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
}

function sumMass(components: RocketJson['rocket']['components']): number {
  let total = 0;
  const visit = (comps: RocketJson['rocket']['components']) => {
    for (const c of comps) {
      if ((c as any).mass) total += (c as any).mass;
      visit(c.children);
    }
  };
  visit(components);
  return total;
}

function renderJson(json: RocketJson) {
  jsonOutput.textContent = JSON.stringify(json, null, 2);
}

// ---------- Download ----------

function downloadJson() {
  if (!currentJson) return;
  const blob = new Blob([JSON.stringify(currentJson, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentJson.rocket.name.replace(/[^a-z0-9]+/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Onshape upload ----------

async function handleUpload() {
  if (!currentJson) return;
  const token = tokenInput.value.trim();
  if (!token) {
    uploadStatus.textContent = 'Please enter an Onshape bearer token.';
    uploadStatus.className = 'status err';
    return;
  }

  uploadBtn.disabled = true;
  uploadStatus.textContent = 'Uploading to Onshape…';
  uploadStatus.className = 'status';

  try {
    const { did, wid, eid } = await uploadRocketToOnshape(token, currentJson);
    uploadStatus.textContent = `Success! Document: ${did} / ${wid} / ${eid}`;
    uploadStatus.className = 'status ok';
  } catch (err: any) {
    uploadStatus.textContent = `Upload failed: ${err.message}`;
    uploadStatus.className = 'status err';
  } finally {
    uploadBtn.disabled = false;
  }
}

// ---------- Event wiring ----------

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = 'var(--accent)';
});
dropZone.addEventListener('dragleave', () => {
  dropZone.style.borderColor = 'var(--border)';
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.style.borderColor = 'var(--border)';
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

downloadBtn.addEventListener('click', downloadJson);
uploadBtn.addEventListener('click', handleUpload);