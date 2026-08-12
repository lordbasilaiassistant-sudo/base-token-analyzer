// Token presets. Add more here — id is whatever, label shows in dropdown.
//
// Emptied 2026-08-12. This shipped with a single preset that preselected one
// specific token as the default analysis target and the page promoted buying
// it. A public analysis tool should not arrive with a position; it should
// arrive empty and analyze whatever you give it. app.js validates the address
// field and reports a clear error when it is blank, so the tool works exactly
// as before — you just bring your own token.
export const PRESETS = {};
