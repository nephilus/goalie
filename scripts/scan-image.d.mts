export interface ImageFinding {
  VulnerabilityID: string;
  PkgName?: string;
  PkgID?: string;
  InstalledVersion: string;
  Severity: string;
  FixedVersion?: string | null;
  Status?: string;
  [key: string]: unknown;
}

export function evaluateImageReport(report: unknown): {
  blocking: ImageFinding[];
  unfixed: ImageFinding[];
};
