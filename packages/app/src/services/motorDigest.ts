/**
 * Desktop OpenRocket's motor digest (24.12 core/motor/MotorDigest.java and the
 * digest steps of its RASP and RockSim loaders), for the app.
 *
 * The port itself is scripts/motor-digest.mjs, one implementation for two
 * consumers: fetch-motor-curves.mjs stores each bundled file's digest at
 * build time (the bundle keeps samples rounded to 0.01 N and no raw text, so
 * the digest cannot be computed from it afterwards), and fetchMotorSpec
 * computes it here for a file downloaded live. Why the digest matters, and
 * what it is over: that file's header.
 */
export { digestMotorFile, digestRasp, digestRse, md5Hex, MotorDigest, DIGEST_DATA_TYPE, motorHeaderMasses } from '../../scripts/motor-digest.mjs';
