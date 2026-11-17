// Plausibility screens, not measured/certified limits. Shared by the shipped
// catalogue tests and preflight advice; the three density units stay separate.
// Shipped sheets after correction span 0.00705–0.09 kg/m²; the built-ins span
// 0.015–0.08. Allow thin films through heavy fabric, but catch g/m² as kg/m².
export const SURFACE_DENSITY_RANGE = { min: 0.005, max: 1 };
// Shipped lines span 0.0000577–0.023252562 kg/m; built-ins extend to 0.45686629
// (heavy rope). Allow lighter threads and heavier straps; flag implausible slips.
export const LINE_DENSITY_RANGE = { min: 0.00001, max: 1 };
