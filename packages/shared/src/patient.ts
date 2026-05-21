import { z } from "zod";

export const ConditionSchema = z.object({
  code: z.string(),
  system: z.string(),
  display: z.string(),
  onsetDate: z.string().optional(),
  abatementDate: z.string().optional(),
  clinicalStatus: z
    .enum(["active", "recurrence", "relapse", "inactive", "remission", "resolved"])
    .optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const MedicationEventSchema = z.object({
  date: z.string(),
  status: z
    .enum(["active", "in-progress", "on-hold", "stopped", "completed"])
    .optional(),
});
export type MedicationEvent = z.infer<typeof MedicationEventSchema>;

export const MedicationSchema = z.object({
  code: z.string(),
  system: z.string(),
  display: z.string(),
  events: z.array(MedicationEventSchema).nonempty(),
});
export type Medication = z.infer<typeof MedicationSchema>;

export const PriorTreatmentSchema = z.object({
  code: z.string(),
  system: z.string(),
  display: z.string(),
  date: z.string().optional(),
});
export type PriorTreatment = z.infer<typeof PriorTreatmentSchema>;

export const LabValueSchema = z.object({
  date: z.string(),
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
});
export type LabValue = z.infer<typeof LabValueSchema>;

export const LabSchema = z.object({
  code: z.string(),
  system: z.string(),
  display: z.string(),
  values: z.array(LabValueSchema).nonempty(),
});
export type Lab = z.infer<typeof LabSchema>;

// Conditions on a `PatientProfile` whose clinicalStatus indicates the
// condition is currently present. The agent treats missing clinicalStatus
// as active (lenient — some sources omit it). Keep this in lockstep with
// any downstream "filter to active" logic — the
// identify-relevant-mechanisms node and its prompt module both depend on
// this set; redefining elsewhere causes silent drift.
export const ACTIVE_CONDITION_STATUSES = new Set<
  "active" | "recurrence" | "relapse"
>(["active", "recurrence", "relapse"]);

export function isActiveCondition(c: { clinicalStatus?: string }): boolean {
  if (!c.clinicalStatus) return true;
  return (ACTIVE_CONDITION_STATUSES as Set<string>).has(c.clinicalStatus);
}

export const PatientProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  ageYears: z.number().int().nonnegative(),
  sex: z.enum(["male", "female", "other", "unknown"]),
  deceased: z.boolean(),
  deceasedDate: z.string().optional(),
  conditions: z.array(ConditionSchema),
  medications: z.array(MedicationSchema),
  labs: z.array(LabSchema),
  priorTreatments: z.array(PriorTreatmentSchema),
});
export type PatientProfile = z.infer<typeof PatientProfileSchema>;
