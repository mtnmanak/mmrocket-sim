/** File spans must be single-line before note producers add structural separators. */
export function noteField(text: string): string {
  return text.replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, '');
}
