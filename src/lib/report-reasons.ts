export const REPORT_REASONS = [
  "Copyright infringement",
  "Inappropriate or offensive content",
  "Spam or misleading listing",
  "Other",
] as const;

// The stored value stays the English key (admin reads it); readers see
// the Albanian label.
export const REPORT_REASON_LABELS: Record<(typeof REPORT_REASONS)[number], string> = {
  "Copyright infringement": "Shkelje e të drejtës së autorit",
  "Inappropriate or offensive content": "Përmbajtje e papërshtatshme ose fyese",
  "Spam or misleading listing": "Spam ose përshkrim mashtrues",
  Other: "Tjetër",
};
