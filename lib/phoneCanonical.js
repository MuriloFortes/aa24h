/** Apenas dígitos. */
export function digitsOnlyPhone(s) {
  return String(s || "").replace(/\D/g, "");
}

/**
 * Extrai o identificador do usuário antes do @ e remove sufixo de dispositivo (`:12`).
 * Ex.: `5511999999999:45@s.whatsapp.net` → `5511999999999` (sem fundir `45` ao número).
 */
export function extractWhatsAppUserDigits(jidOrPhone) {
  if (jidOrPhone == null) return "";
  let user = String(jidOrPhone).trim().split("@")[0] || "";
  if (user.includes(":")) user = user.split(":")[0];
  return digitsOnlyPhone(user);
}

function jidHasPhoneNumberForm(jid) {
  const j = String(jid || "").toLowerCase();
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@c.us");
}

/**
 * Evolution/Baileys pode mandar `remoteJid` em número e `remoteJidAlt` em @lid, ou o contrário.
 * Para automação (cotação, conversas) usamos só o JID que representa o telefone (PN).
 */
export function digitsFromInboundMessageKey(key) {
  if (!key) return "";
  const rj = String(key.remoteJid || "").trim();
  const alt = String(key.remoteJidAlt || "").trim();
  if (jidHasPhoneNumberForm(rj)) return extractWhatsAppUserDigits(rj);
  if (jidHasPhoneNumberForm(alt)) return extractWhatsAppUserDigits(alt);
  return "";
}

/**
 * Celular BR: após `55` vem DDD (2) + assinante.
 * Formato novo: 9 + 8 dígitos (total 11 após DDD). Formato antigo: 8 dígitos (móvel costuma começar com 6–9).
 * Fixo: 8 dígitos costuma começar com 2–5 — não insere o 9.
 * Unifica "com 9" e "sem 9" na mesma chave para threads / cotações.
 */
export function normalizeBrazilMobileNineAfter55(digitsWith55) {
  const d = digitsOnlyPhone(digitsWith55);
  if (!d.startsWith("55") || d.length < 12) return d;

  const after55 = d.slice(2);
  const ddd = after55.slice(0, 2);
  if (!/^\d{2}$/.test(ddd)) return d;

  // 55 + DDD + 99 + 8 dígitos (9 duplicado após DDD — comum em importações / APIs)
  if (after55.length === 12) {
    const m = after55.match(/^(\d{2})99(\d{8})$/);
    if (m) {
      return normalizeBrazilMobileNineAfter55(`55${m[1]}9${m[2]}`);
    }
  }

  // 55 + DDD + 99 + 9 dígitos (ex.: 11 99 987654321)
  if (after55.length === 13) {
    const m = after55.match(/^(\d{2})99(\d{9})$/);
    if (m) {
      return normalizeBrazilMobileNineAfter55(`55${m[1]}9${m[2]}`);
    }
  }

// 55 + DDD + 8 (fixo ou celular antigo)
  if (after55.length === 10) {
    const sub8 = after55.slice(2);
    if (sub8.length !== 8) return d;
    // Fixo: começa com 2-5, não adiciona 9
    if (/^[2345]/.test(sub8)) return d;
    // Celular moderno: começa com 6-9 (sem o 9 após DDD). Ex: 11 1832759 → adiciona 9 → 11 91832759
    if (/^[6789]/.test(sub8)) return `55${ddd}9${sub8}`;
    return d;
  }

  // 55 + DDD + 9 (celular atual); já canônico para o caso "com 9"
  if (after55.length === 11) {
    const sub9 = after55.slice(2);
    if (sub9.length === 9 && sub9[0] === "9") return d;
    return d;
  }

  return d;
}

/**
 * Chave única para WhatsApp BR + painel (Evolution usa 55 + DDD + número).
 * Evita duas "conversas" (inbound vs outbound) por variação 11 vs 5511 ou 9º dígito.
 */
export function canonicalBrPhone(raw) {
  let d = digitsOnlyPhone(raw);
  if (!d) return "";
  if (d.length >= 10 && d.length <= 11 && !d.startsWith("55")) {
    d = `55${d}`;
  }
  if (d.length >= 12 && d.startsWith("55")) {
    return normalizeBrazilMobileNineAfter55(d);
  }
  return d;
}

/**
 * Única chave para `messages.phone`, Socket e listagem — evita duas “conversas”
 * para o mesmo contato (11 vs 5511, JID vs dígitos, espaços).
 */
export function resolveMessageThreadKey(input) {
  if (input == null || input === "") return "";
  const s = String(input).trim();
  if (!s) return "";
  /** Sessão do chat web — não é linha WhatsApp; não extrair só dígitos. */
  if (/^web[_-]/i.test(s)) return s;
  let digits = "";
  if (s.includes("@")) {
    digits = extractWhatsAppUserDigits(s);
  } else {
    digits = digitsOnlyPhone(s);
  }
  if (!digits) return "";
  const c = canonicalBrPhone(digits);
  return c || digits;
}

/** Mesma linha WhatsApp BR (com/sem 9 após DDD, JID ou dígitos). */
export function sameBrWhatsAppLine(a, b) {
  const ra = resolveMessageThreadKey(a);
  const rb = resolveMessageThreadKey(b);
  if (ra && rb && ra === rb) return true;
  return false;
}

/**
 * Conjunto de chaves possíveis para casar contato BR (canônico + variante sem o 9 móvel após o DDD).
 * Usado em cotações quando o WhatsApp envia o JID em formato antigo.
 */
export function brPhoneLookupSet(input) {
  const s = new Set();
  const main = resolveMessageThreadKey(input);
  if (main) {
    s.add(main);
    if (main.startsWith("55") && main.length === 13) {
      const after = main.slice(2);
      if (after.length === 11 && after[2] === "9") {
        const ddd = after.slice(0, 2);
        const eight = after.slice(3);
        if (eight.length === 8) s.add(`55${ddd}${eight}`);
      }
    }
  }
  const d = digitsOnlyPhone(input);
  if (d) {
    const r2 = resolveMessageThreadKey(d);
    if (r2) s.add(r2);
  }
  return [...s];
}

/** Casamento para cotação / prestador: interseção das variantes BR ou últimos 9 dígitos nacionais. */
export function phonesMatchForBrazilQuote(a, b) {
  if (!a || !b) return false;
  if (sameBrWhatsAppLine(a, b)) return true;
  const A = new Set(brPhoneLookupSet(a));
  const B = new Set(brPhoneLookupSet(b));
  for (const x of A) {
    if (B.has(x)) return true;
  }
  const da = digitsOnlyPhone(a);
  const db = digitsOnlyPhone(b);
  if (da.length >= 9 && db.length >= 9 && da.startsWith("55") && db.startsWith("55") && da.slice(-9) === db.slice(-9)) {
    return true;
  }
  return false;
}

/** Normaliza todas as linhas de `messages` para a mesma chave canônica (unifica threads). */
export function normalizeMessagesThreadKeys(db) {
  if (!db?.prepare) return 0;
  let updated = 0;
  try {
    for (let round = 0; round < 10; round++) {
      let pass = 0;
      const rows = db
        .prepare("SELECT DISTINCT phone AS p FROM messages WHERE phone IS NOT NULL AND trim(phone) != ''")
        .all();
      for (const { p } of rows) {
        const c = resolveMessageThreadKey(p);
        if (!c || c === p) continue;
        const r = db.prepare("UPDATE messages SET phone = ? WHERE phone = ?").run(c, p);
        pass += r.changes || 0;
      }
      updated += pass;
      if (pass === 0) break;
    }
  } catch {
    /* ignore */
  }
  return updated;
}
