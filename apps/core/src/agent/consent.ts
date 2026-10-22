export function consents(said: string, forms: string[]): boolean {
  if (/[？?]/.test(said)) return false;
  return forms.includes(said.replace(/[。！!～~\s]+$/, "").trim());
}
