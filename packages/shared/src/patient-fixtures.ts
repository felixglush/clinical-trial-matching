export type PatientFixture = {
  slug: string;
  uuid: string;
  displayName: string;
  archetype: string;
};

export const PATIENT_FIXTURES: readonly PatientFixture[] = [
  {
    slug: "hedy-sauer",
    uuid: "8af9d5d7-2600-556b-5158-64501509f9f5",
    displayName: "Hedy Sauer",
    archetype: "Breast cancer (clean)",
  },
  {
    slug: "brady-schmidt",
    uuid: "8580a690-4d97-5739-4f07-788ad44e6f04",
    displayName: "Brady Schmidt",
    archetype: "NSCLC stage 1",
  },
  {
    slug: "pamela-lesch",
    uuid: "6bc4cd5d-0216-17a9-8192-ac2209957d3a",
    displayName: "Pamela Lesch",
    archetype: "Complex comorbid (breast cancer + T2DM + CKD)",
  },
  {
    slug: "marvin-weissnat",
    uuid: "4aaa0001-3832-cc52-e2f3-47aad08f4284",
    displayName: "Marvin Weissnat",
    archetype: "Rheumatoid arthritis",
  },
] as const;
