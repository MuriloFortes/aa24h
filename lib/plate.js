/**
 * Normaliza placa veicular BR (Mercosul ou antiga) e chassi numérico.
 * Remove separadores (espaço, hífen, pontuação), Unicode “estranho”, converte para maiúsculas.
 */
export function normalizeBrazilianPlate(raw) {
  if (raw == null || raw === "") return "";
  const s = String(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (s.length <= 4) return s;
  if (s.length >= 7) return s.slice(0, 7);
  return s;
}

/** Mercosul: LLLNLNN — corrige O/0 em posições típicas */
export function fixMercosulOZeroConfusion(s) {
  if (!s || s.length !== 7) return s;
  if (!/^[A-Z0-9]{7}$/.test(s)) return s;
  const a = s.split("");
  for (let i = 0; i < 3; i++) {
    if (a[i] === "0") a[i] = "O";
  }
  if (a[3] === "O") a[3] = "0";
  if (a[4] === "0") a[4] = "O";
  for (const i of [5, 6]) {
    if (a[i] === "O") a[i] = "0";
  }
  return a.join("");
}

/** Formato antigo: LLLNNNN — letras nas 3 primeiras, dígitos no restante */
export function fixOldPlateOZeroConfusion(s) {
  if (!s || s.length !== 7) return s;
  if (!/^[A-Z0-9]{7}$/.test(s)) return s;
  const a = s.split("");
  for (let i = 0; i < 3; i++) {
    if (a[i] === "0") a[i] = "O";
  }
  for (let i = 3; i < 7; i++) {
    if (a[i] === "O") a[i] = "0";
  }
  return a.join("");
}

/**
 * Extrai sequência alfanumérica “tipo placa” de texto ruidoso
 * (ex.: "o x j 2 e 3 2", "placa oxj 2e32").
 */
export function compactPlateFromNoisyText(raw) {
  if (raw == null || raw === "") return "";
  return String(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Variantes de placa/chassi para consulta SGA Hinova.
 * A doc usa exemplos como AAA-1111 no path; alguns ambientes aceitam Mercosul com hífen (XXX-1X23).
 */
export function buildPlateVariantsForSgaRequest(raw) {
  const noisy = compactPlateFromNoisyText(raw);
  if (!noisy) return [];

  const variants = new Set();
  const push = (v) => {
    if (v && (v.length === 7 || v.length === 17)) variants.add(v);
  };

  if (noisy.length >= 7) {
    const p = noisy.slice(0, 7);
    push(p);
    push(p.toLowerCase());
    push(fixMercosulOZeroConfusion(p));
    push(fixOldPlateOZeroConfusion(p));

    const m = fixMercosulOZeroConfusion(p);
    const o = fixOldPlateOZeroConfusion(p);
    for (const v of [p, m, o]) {
      if (!v || v.length !== 7) continue;
      push(v);
      push(v.toLowerCase());
      if (/^[A-Z]{3}\d[A-Z]\d{2}$/.test(v)) {
        push(`${v.slice(0, 3)}-${v.slice(3)}`);
        push(`${v.slice(0, 3)}-${v.slice(3)}`.toLowerCase());
      }
      if (/^[A-Z]{3}\d{4}$/.test(v)) {
        push(`${v.slice(0, 3)}-${v.slice(3)}`);
        push(`${v.slice(0, 3)}-${v.slice(3)}`.toLowerCase());
      }
    }
  }

  if (noisy.length >= 17) {
    push(noisy.slice(0, 17));
  }

  const max = Math.min(Number(process.env.SGA_PLATE_VARIANTS_MAX || 12) || 12, 24);
  return [...variants].slice(0, max);
}
