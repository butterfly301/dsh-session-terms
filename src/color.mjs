export const TERM_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const TERM_COLOR_LENGTH = 7;

export function isTermColor(value) {
  return (
    typeof value === 'string' &&
    value.length === TERM_COLOR_LENGTH &&
    TERM_COLOR_PATTERN.test(value)
  );
}
