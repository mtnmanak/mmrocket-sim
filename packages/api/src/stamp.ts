import { APP_VERSION, CURVES_GENERATED, MOTORS_GENERATED } from '../../app/src/headless/index.js';

/**
 * The version stamp every API body carries, success or error: the app release, the
 * engine it runs and the BUNDLED catalogue snapshot (the Worker never installs an overlay).
 */
export const stamp = () => ({ appVersion: APP_VERSION, engine: { openRocket: '24.12', appVersion: APP_VERSION },
  catalogue: { motorsGenerated: MOTORS_GENERATED, curvesGenerated: CURVES_GENERATED } });

/** The Worker's only JSON response: the route's own keys, then the stamp beside them. */
export function stampedJson(body: object, init?: ResponseInit): Response {
  return Response.json({ ...body, ...stamp() }, init);
}
