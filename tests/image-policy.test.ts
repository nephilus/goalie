import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateImageReport } from '../scripts/scan-image.mjs';

type Finding = {
  VulnerabilityID: string;
  PkgID: string;
  PkgName: string;
  InstalledVersion: string;
  Severity: string;
  FixedVersion?: string;
  Status?: string;
};

type Package = {
  ID: string;
  Name: string;
  Version: string;
};

type Report = {
  SchemaVersion: number;
  ArtifactName: string;
  ArtifactType: string;
  Metadata: {
    ImageID: string;
    Architecture: string;
    OS: string | { Family: string; Name: string };
  };
  Results: Array<{
    Target: string;
    Class: string;
    Type: string;
    Packages: Package[];
    Vulnerabilities: Finding[];
  }>;
};

const osPackage = (name: string, version: string): Package => ({
  ID: name,
  Name: name,
  Version: version,
});

const languagePackage = (name: string, version: string): Package => ({
  ID: `npm:${name}`,
  Name: name,
  Version: version,
});

const finding = (id: string, packageName: string, severity: string, fixedVersion?: string): Finding => ({
  VulnerabilityID: id,
  PkgID: packageName,
  PkgName: packageName,
  InstalledVersion: '1.0.0',
  Severity: severity,
  ...(fixedVersion === undefined ? {} : { FixedVersion: fixedVersion }),
  Status: fixedVersion ? 'fixed' : 'affected',
});

const baseReport = (): Report => ({
  SchemaVersion: 2,
  ArtifactName: 'goalie:ci',
  ArtifactType: 'container_image',
  Metadata: {
    ImageID: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    Architecture: 'amd64',
    OS: { Family: 'alpine', Name: '3.23.0' },
  },
  Results: [
    {
      Target: 'alpine:3.23',
      Class: 'os-pkgs',
      Type: 'alpine',
      Packages: [osPackage('busybox', '1.37.0-r19'), osPackage('libcrypto3', '3.5.4-r0')],
      Vulnerabilities: [],
    },
    {
      Target: '/app/node_modules',
      Class: 'lang-pkgs',
      Type: 'node-pkg',
      Packages: [languagePackage('@goalie/runtime', '0.1.0')],
      Vulnerabilities: [],
    },
  ],
});

const withFindings = (...findings: Finding[]): Report => {
  const report = baseReport();
  const osPackages = new Set(report.Results[0].Packages.map((pkg) => pkg.Name));
  for (const item of findings) {
    const result = osPackages.has(item.PkgName) ? report.Results[0] : report.Results[1];
    result.Vulnerabilities.push(item);
    if (!result.Packages.some((pkg) => pkg.Name === item.PkgName)) {
      result.Packages.push(osPackage(item.PkgName, item.InstalledVersion));
    }
  }
  return report;
};

test('fixable HIGH and CRITICAL findings are returned as blocking', () => {
  const high = finding('CVE-2026-0001', 'busybox', 'HIGH', '1.37.0-r20');
  const critical = finding('CVE-2026-0002', 'libcrypto3', 'CRITICAL', '3.5.5-r0');

  assert.deepEqual(evaluateImageReport(withFindings(high, critical)), {
    blocking: [high, critical],
    unfixed: [],
  });
});

test('unfixed HIGH and CRITICAL findings remain visible without blocking', () => {
  const unfixedHigh = finding('CVE-2026-0003', 'busybox', 'HIGH', '');
  const unfixedCritical = finding('CVE-2026-0004', 'libcrypto3', 'CRITICAL');
  const fixedLow = finding('CVE-2026-0005', '@goalie/runtime', 'LOW', '0.1.1');
  const fixedMedium = finding('CVE-2026-0006', '@goalie/runtime', 'MEDIUM', '0.1.2');

  assert.deepEqual(evaluateImageReport(withFindings(unfixedHigh, unfixedCritical, fixedLow, fixedMedium)), {
    blocking: [],
    unfixed: [unfixedHigh, unfixedCritical],
  });
});

test('lower severity findings do not enter either gate result', () => {
  const low = finding('CVE-2026-0010', 'busybox', 'LOW', '1.37.0-r20');
  const medium = finding('CVE-2026-0011', 'libcrypto3', 'MEDIUM');

  assert.deepEqual(evaluateImageReport(withFindings(low, medium)), {
    blocking: [],
    unfixed: [],
  });
});

test('missing, empty, and unsupported inventories fail closed', () => {
  const missingMetadata = baseReport() as unknown as Record<string, unknown>;
  delete missingMetadata.Metadata;
  assert.throws(() => evaluateImageReport(missingMetadata));

  const missingResults = baseReport() as unknown as Record<string, unknown>;
  delete missingResults.Results;
  assert.throws(() => evaluateImageReport(missingResults));

  const missingPackages = baseReport();
  delete (missingPackages.Results[0] as unknown as Record<string, unknown>).Packages;
  assert.throws(() => evaluateImageReport(missingPackages));

  const emptyOsInventory = baseReport();
  emptyOsInventory.Results[0].Packages = [];
  assert.throws(() => evaluateImageReport(emptyOsInventory));
  const emptyRuntimeInventory = baseReport();
  emptyRuntimeInventory.Results[1].Packages = [];
  assert.throws(() => evaluateImageReport(emptyRuntimeInventory));

  const unsupportedOs = baseReport();
  unsupportedOs.Metadata.OS = { Family: 'debian', Name: '13' };
  assert.throws(() => evaluateImageReport(unsupportedOs));

  const missingRuntimeInventory = baseReport();
  missingRuntimeInventory.Results = [missingRuntimeInventory.Results[0]];
  assert.throws(() => evaluateImageReport(missingRuntimeInventory));

  const unsupportedRuntimeInventory = baseReport();
  unsupportedRuntimeInventory.Results[1].Type = 'python-pkg';
  assert.throws(() => evaluateImageReport(unsupportedRuntimeInventory));
});

test('malformed findings and invalid severity fail closed', () => {
  const invalidSeverity = withFindings(finding('CVE-2026-0020', 'busybox', 'URGENT', '1.2.3'));
  assert.throws(() => evaluateImageReport(invalidSeverity));

  const malformedFinding = withFindings(finding('CVE-2026-0021', 'busybox', 'HIGH', '1.2.3'));
  const malformed = malformedFinding.Results[0].Vulnerabilities[0] as unknown as Record<string, unknown>;
  delete malformed.PkgName;
  delete malformed.PkgID;
  assert.throws(() => evaluateImageReport(malformedFinding));
});
