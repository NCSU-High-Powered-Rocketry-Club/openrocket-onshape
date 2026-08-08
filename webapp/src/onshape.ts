/**
 * Onshape REST API client.
 *
 * Uploads the parsed rocket JSON to an Onshape document by creating features
 * through the Feature Studio API. The custom feature (written separately)
 * consumes the JSON payload to construct the 3D geometry.
 *
 * Prerequisites:
 *  - An Onshape OAuth2 access token (or API key) with write access
 *  - An Onshape document + element to create features in
 */

import type { RocketJson } from './types';

const ONSHAPE_API_BASE = 'https://cad.onshape.com/api';

export interface OnshapeCredentials {
  accessToken: string;
}

export interface OnshapeTarget {
  did: string; // document id
  wid: string; // workspace id
  eid: string; // element id
}

/**
 * Create a new document in the user's Onshape account.
 * @param token OAuth2 bearer token
 * @param name Document name
 */
export async function createDocument(token: string, name: string): Promise<{ did: string; wid: string }> {
  const resp = await fetch(`${ONSHAPE_API_BASE}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      ownerType: 0, // my Onshape
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Failed to create Onshape document: ${resp.status} ${body}`);
  }

  const data = await resp.json();
  return {
    did: data.id,
    wid: (data.defaultWorkspace && data.defaultWorkspace.id) || data.document.defaultWorkspace.id,
  };
}

/**
 * Create a new part studio element in an Onshape document.
 * @param token Bearer token
 * @param did Document id
 * @param wid Workspace id
 * @param name Element name
 */
export async function createPartStudio(
  token: string,
  did: string,
  wid: string,
  name = 'Rocket'
): Promise<{ eid: string }> {
  // Find the default tab / element
  const elementsResp = await fetch(`${ONSHAPE_API_BASE}/documents/d/${did}/w/${wid}/elements`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!elementsResp.ok) throw new Error(`Failed to list elements: ${elementsResp.status}`);

  const elements = await elementsResp.json();
  const partStudios = (elements as any[]).filter((e) => e.elementType === 'PARTSTUDIO');
  if (partStudios.length > 0) {
    return { eid: partStudios[0].id };
  }

  // Create a new part studio (uses the Element API)
  const resp = await fetch(`${ONSHAPE_API_BASE}/documents/d/${did}/w/${wid}/elements`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      type: 'PARTSTUDIO',
    }),
  });
  if (!resp.ok) throw new Error(`Failed to create part studio: ${resp.status}`);
  const data = await resp.json();
  return { eid: data.id };
}

/**
 * Upload the rocket geometry JSON to the custom feature.
 *
 * The JSON is embedded as a feature parameter of type STRING (the custom
 * feature's `rocketJson` parameter). The Feature Studio code is responsible
 * for parsing the JSON and constructing the geometry.
 */
export async function uploadToCustomFeature(
  token: string,
  target: OnshapeTarget,
  rocketJson: RocketJson
): Promise<void> {
  const featuresResp = await fetch(
    `${ONSHAPE_API_BASE}/features/d/${target.did}/w/${target.wid}/e/${target.eid}/features`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!featuresResp.ok) throw new Error(`Failed to list features: ${featuresResp.status}`);
  const features = await featuresResp.json();

  // Find the custom feature (assuming the user has added it to the part studio)
  const customFeatures = (features as any[]).filter((f) => f.type && f.type.startsWith('openRocket'));
  if (customFeatures.length === 0) {
    throw new Error(
      'No OpenRocket custom feature found. Add the custom feature to the part studio first.'
    );
  }

  // Update the custom feature's rocketJson parameter
  const feature = customFeatures[0];
  const params = feature.parameters.map((p: any) => ({ ...p }));
  const jsonParam = params.find((p: any) => p.message && p.message.parameterId === 'rocketJson');
  if (!jsonParam) {
    throw new Error('Custom feature is missing the rocketJson parameter.');
  }

  // Update the parameter value (string parameter)
  jsonParam.message.value = JSON.stringify(rocketJson);

  const updateResp = await fetch(
    `${ONSHAPE_API_BASE}/features/d/${target.did}/w/${target.wid}/e/${target.eid}/features/update`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        features: [
          {
            feature,
            params,
            featureId: feature.featureId,
          },
        ],
      }),
    }
  );

  if (!updateResp.ok) {
    const body = await updateResp.text();
    throw new Error(`Failed to update custom feature: ${updateResp.status} ${body}`);
  }
}

/**
 * Convenience wrapper: create document + part studio + upload JSON.
 */
export async function uploadRocketToOnshape(
  token: string,
  rocketJson: RocketJson
): Promise<{ did: string; wid: string; eid: string }> {
  const { did, wid } = await createDocument(token, rocketJson.rocket.name);
  const { eid } = await createPartStudio(token, did, wid, rocketJson.rocket.name);
  await uploadToCustomFeature(token, { did, wid, eid }, rocketJson);
  return { did, wid, eid };
}