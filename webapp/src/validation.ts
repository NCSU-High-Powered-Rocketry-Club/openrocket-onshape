import type { RocketComponent, RocketJson, WarningDetail, WarningSeverity } from './types';

const PHYSICAL_COMPONENTS = new Set<RocketComponent['type']>([
  'nosecone', 'transition', 'bodytube', 'trapezoidfinset', 'ellipticalfinset',
  'freeformfinset', 'tubefinset', 'launchlug', 'railbutton', 'innertube',
  'tubecoupler', 'centeringring', 'bulkhead', 'engineblock', 'parachute',
  'streamer', 'shockcord', 'masscomponent',
]);

function addWarning(rocketJson: RocketJson, severity: WarningSeverity, message: string, component?: RocketComponent) {
  const detail: WarningDetail = {
    severity,
    message,
    ...(component ? { componentId: component.id, componentType: component.type } : {}),
  };
  const existing = rocketJson.warningDetails?.find((item) => item.severity === severity && item.message === message);
  if (existing) return;
  rocketJson.warningDetails = [...(rocketJson.warningDetails ?? []), detail];
  rocketJson.warnings = [...rocketJson.warnings, `[${severity.toUpperCase()}] ${message}`];
}

function numberField(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkPositive(rocketJson: RocketJson, component: RocketComponent, key: string, value: unknown, label = key) {
  if (!numberField(value) || value <= 0) addWarning(rocketJson, 'high', `${label} must be greater than zero for ${component.name}.`, component);
}

function checkNonNegative(rocketJson: RocketJson, component: RocketComponent, key: string, value: unknown, label = key) {
  if (!numberField(value) || value < 0) addWarning(rocketJson, 'high', `${label} must be zero or greater for ${component.name}.`, component);
}

function validateGeometry(rocketJson: RocketJson, component: RocketComponent) {
  const p = component.params as any;
  if (!p || typeof p !== 'object') {
    addWarning(rocketJson, 'high', `Component parameters are malformed for ${component.name}.`, component);
    return;
  }

  switch (component.type) {
    case 'nosecone':
      // A tail cone (<isflipped>) is a full-radius base tapering to a POINT at
      // the aft end, so aftRadius is legitimately 0. Check whichever end is the
      // tip against "non-negative" and the base against "positive", so a correct
      // tail cone is never reported as malformed.
      checkPositive(rocketJson, component, 'length', p.length);
      if (p.flipped === true) {
        if (!p.foreRadiusAutomatic) checkPositive(rocketJson, component, 'foreRadius', p.foreRadius, 'Base radius (tail cone)');
        if (!p.baseRadiusAutomatic) checkNonNegative(rocketJson, component, 'aftRadius', p.aftRadius, 'Tip radius (tail cone)');
      } else {
        if (!p.foreRadiusAutomatic) checkNonNegative(rocketJson, component, 'foreRadius', p.foreRadius, 'Fore radius');
        if (!p.baseRadiusAutomatic) checkPositive(rocketJson, component, 'aftRadius', p.aftRadius, 'Aft radius');
      }
      if (!p.filled) checkPositive(rocketJson, component, 'thickness', p.thickness);
      break;
    case 'transition':
      checkPositive(rocketJson, component, 'length', p.length);
      if (!p.foreRadiusAutomatic) checkNonNegative(rocketJson, component, 'foreRadius', p.foreRadius, 'Fore radius');
      if (!p.baseRadiusAutomatic) checkPositive(rocketJson, component, 'aftRadius', p.aftRadius, 'Aft radius');
      if (!p.filled) checkPositive(rocketJson, component, 'thickness', p.thickness);
      break;
    case 'bodytube':
      checkPositive(rocketJson, component, 'length', p.length);
      checkPositive(rocketJson, component, 'outerRadius', p.outerRadius);
      if (!p.filled) checkPositive(rocketJson, component, 'thickness', p.thickness);
      break;
    case 'trapezoidfinset':
    case 'ellipticalfinset':
      checkPositive(rocketJson, component, 'rootChord', p.rootChord);
      checkPositive(rocketJson, component, 'height', p.height);
      checkPositive(rocketJson, component, 'thickness', p.thickness);
      if (component.type === 'trapezoidfinset') checkNonNegative(rocketJson, component, 'tipChord', p.tipChord, 'Tip chord');
      if (component.type === 'trapezoidfinset') checkNonNegative(rocketJson, component, 'sweepLength', p.sweepLength, 'Sweep length');
      break;
    case 'freeformfinset':
      if (!Array.isArray(p.points) || p.points.length < 3) addWarning(rocketJson, 'high', `Freeform fin must contain at least three points for ${component.name}.`, component);
      checkPositive(rocketJson, component, 'thickness', p.thickness);
      break;
    case 'tubefinset':
      checkPositive(rocketJson, component, 'length', p.length);
      checkPositive(rocketJson, component, 'outerRadius', p.outerRadius);
      checkPositive(rocketJson, component, 'thickness', p.thickness);
      break;
    case 'launchlug':
    case 'innertube':
    case 'tubecoupler':
    case 'centeringring':
    case 'bulkhead':
    case 'engineblock':
      checkPositive(rocketJson, component, 'length', p.length);
      checkPositive(rocketJson, component, 'outerRadius', p.outerRadius);
      if (p.autoInnerRadius) checkPositive(rocketJson, component, 'innerRadius', p.innerRadius, 'Resolved inner radius');
      else if (component.type !== 'bulkhead') checkNonNegative(rocketJson, component, 'innerRadius', p.innerRadius, 'Inner radius');
      if (component.type !== 'bulkhead' && component.type !== 'centeringring') checkPositive(rocketJson, component, 'thickness', p.thickness);
      break;
    case 'railbutton':
      checkPositive(rocketJson, component, 'outerDiameter', p.outerDiameter);
      checkPositive(rocketJson, component, 'totalHeight', p.totalHeight, 'Total height');
      break;
    case 'parachute':
      checkPositive(rocketJson, component, 'diameter', p.diameter);
      checkPositive(rocketJson, component, 'packedLength', p.packedLength);
      checkPositive(rocketJson, component, 'packedRadius', p.packedRadius);
      break;
    case 'streamer':
      checkPositive(rocketJson, component, 'stripLength', p.stripLength);
      checkPositive(rocketJson, component, 'stripWidth', p.stripWidth);
      break;
    case 'shockcord':
      checkPositive(rocketJson, component, 'cordLength', p.cordLength);
      break;
  }
}

function validateCounts(rocketJson: RocketJson, component: RocketComponent) {
  const p = component.params as any;
  const position = component.position as any;
  if (position && (!Number.isInteger(position.instanceCount) || position.instanceCount < 1)) addWarning(rocketJson, 'high', `Instance count must be a positive integer for ${component.name}.`, component);
  if (p?.finCount !== undefined && (!Number.isInteger(p.finCount) || p.finCount < 1)) addWarning(rocketJson, 'high', `Fin count must be a positive integer for ${component.name}.`, component);

  // A motor mount may hold several motor configurations, and only the one
  // matching the rocket's default configuration is extracted. That was harmless
  // while the motor data went unused; now it is turned into a solid, so which
  // configuration won decides the geometry, and saying so is the difference
  // between a known simplification and a silent one.
  const mount = p?.motorMount;
  if (mount && typeof mount.configurationCount === 'number' && mount.configurationCount > 1) {
    const others = (mount.configurations ?? [])
      .map((c: { designation: string }) => c.designation)
      .filter((d: string) => d && d !== mount.designation);
    const alsoOn = others.length > 0 ? ` Also defined: ${others.join(', ')}.` : '';
    addWarning(rocketJson, 'medium', `${component.name}: ${mount.configurationCount} motor configurations are defined; the default configuration's "${mount.designation || 'unnamed motor'}" is used for the motor geometry.${alsoOn}`, component);
  }
}

function validateMaterial(rocketJson: RocketJson, component: RocketComponent) {
  if (!PHYSICAL_COMPONENTS.has(component.type)) return;
  // A mass component is defined by its explicit mass override, not a material.
  if (component.type === 'masscomponent') return;
  const p = component.params as any;
  const material = component.type === 'parachute' || component.type === 'streamer' || component.type === 'shockcord'
    ? p?.material
    : component.material;
  if (!material || !material.name?.trim()) addWarning(rocketJson, 'medium', `Material name is not defined for ${component.name}.`, component);
  else if (!numberField(material.density) || material.density <= 0) addWarning(rocketJson, 'high', `Material density must be greater than zero for ${component.name}.`, component);
}

function validateAutoDimensions(rocketJson: RocketJson, component: RocketComponent) {
  const p = component.params as any;
  if (p?.autoOuterRadius && (!numberField(p.outerRadius) || p.outerRadius <= 0)) addWarning(rocketJson, 'high', `Automatic outer radius could not be resolved for ${component.name}.`, component);
  if (p?.autoInnerRadius && (!numberField(p.innerRadius) || p.innerRadius <= 0)) addWarning(rocketJson, 'high', `Automatic inner radius could not be resolved for ${component.name}.`, component);
  if ((p?.foreRadiusAutomatic || p?.baseRadiusAutomatic) && !numberField(p.foreRadius) && !numberField(p.aftRadius)) addWarning(rocketJson, 'high', `Automatic radius could not be resolved for ${component.name}.`, component);
}

function visit(rocketJson: RocketJson, component: RocketComponent) {
  // Mass is normally derived from geometry × material density. OpenRocket's
  // optional mass override is not required for a component to be valid.
  if (typeof component.mass === 'number' && component.mass <= 0) addWarning(rocketJson, 'low', `Mass is zero or negative for ${component.name}.`, component);
  if (component.color?.alpha === 0) addWarning(rocketJson, 'low', `Opacity is 0 for ${component.name}; it will be completely invisible.`, component);
  validateMaterial(rocketJson, component);
  validateGeometry(rocketJson, component);
  validateCounts(rocketJson, component);
  validateAutoDimensions(rocketJson, component);
  for (const child of component.children) visit(rocketJson, child);
}

function preserveExistingWarnings(rocketJson: RocketJson) {
  const details: WarningDetail[] = (rocketJson.warningDetails = []);
  for (const message of rocketJson.warnings) {
    const match = message.match(/^\[(ERROR|HIGH|MEDIUM|LOW|INFO)\]\s*(.*)$/);
    if (match) {
      details.push({ severity: match[1].toLowerCase() as WarningSeverity, message: match[2] });
    } else if (message.includes('auto ') || message.includes('Automatic ')) {
      details.push({ severity: 'high', message });
    } else if (message.startsWith('OpenRocket file format version:')) {
      details.push({ severity: 'info', message });
    } else {
      details.push({ severity: 'high', message });
    }
  }
}

const SEVERITY_RANK: Record<WarningSeverity, number> = {
  error: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function rankWarnings(warnings: WarningDetail[]): WarningDetail[] {
  return [...warnings].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    return `${a.componentType ?? ''}:${a.componentId ?? ''}:${a.message}`.localeCompare(
      `${b.componentType ?? ''}:${b.componentId ?? ''}:${b.message}`
    );
  });
}

export function validateRocketJson(rocketJson: RocketJson): void {
  preserveExistingWarnings(rocketJson);
  for (const component of rocketJson.rocket.components) visit(rocketJson, component);
  rocketJson.warningDetails = rankWarnings(rocketJson.warningDetails ?? []);
}

