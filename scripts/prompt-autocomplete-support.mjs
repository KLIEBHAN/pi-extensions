/**
 * Single source of truth for the Pi host versions Prompt Autocomplete supports.
 *
 * Pi requires its core packages to stay `"*"` peers and installs packages
 * without peer solving, so peer ranges cannot encode a host requirement. The
 * executable compatibility matrix in test/pi-compat-matrix.test.ts is the
 * contract instead: every entry is installed as a matched
 * pi-ai/pi-coding-agent/pi-tui triplet and must pass a discovery/load smoke and
 * an editor/request lifecycle smoke.
 */

/** Lowest Pi version the package promises to work on; first matrix entry. */
export const MINIMUM_SUPPORTED_PI = "0.80.6";

/** Matched host triplets the matrix verifies, ascending. */
export const SUPPORTED_PI_MATRIX = ["0.80.6", "0.82.0", "0.83.0"];

/**
 * A host below the documented baseline, probed but not supported.
 *
 * Since 0.2.1 the extension imports the `@earendil-works/pi-ai` root specifier,
 * which old pre-split pi-ai releases satisfy directly, so 0.79 currently loads
 * and passes both smokes. The probe pins that knowledge: the moment it fails,
 * the baseline has become a technical floor and the probe must be converted to
 * an expected-failure assertion rather than deleted.
 */
export const BELOW_BASELINE_PI_PROBE = "0.79.10";
