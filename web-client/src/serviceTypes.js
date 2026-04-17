/** Tipos de serviço de prestadores (valores persistidos em CSV no campo `services`) */
export const SERVICE_TYPES = [
  { id: "reboque", label: "Reboque" },
  { id: "carga_bateria", label: "Carga de bateria" },
  { id: "troca_pneu", label: "Troca de pneu" },
  { id: "chaveiro", label: "Chaveiro" },
  { id: "transporte_passageiros", label: "Transporte de passageiros" },
];

export function formatServiceList(csv) {
  if (!csv || typeof csv !== "string") return "—";
  const map = Object.fromEntries(SERVICE_TYPES.map((x) => [x.id, x.label]));
  const parts = csv
    .split(",")
    .map((k) => map[k.trim()] || k.trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}
