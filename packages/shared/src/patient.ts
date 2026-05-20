import { z } from "zod";

export const ConditionSchema = z.object({
  code: z.string(),
  display: z.string(),
  onsetDate: z.string().optional(),
  clinicalStatus: z.enum(["active", "resolved", "remission", "inactive"]).optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const MedicationSchema = z.object({
  code: z.string(),
  display: z.string(),
  status: z.enum(["active", "stopped", "completed"]).optional(),
});
export type Medication = z.infer<typeof MedicationSchema>;

export const LabSchema = z.object({
  code: z.string(),
  display: z.string(),
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  date: z.string().optional(),
});
export type Lab = z.infer<typeof LabSchema>;

export const PatientProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  ageYears: z.number().int().nonnegative(),
  sex: z.enum(["male", "female", "other", "unknown"]),
  conditions: z.array(ConditionSchema),
  medications: z.array(MedicationSchema),
  labs: z.array(LabSchema),
  priorTreatments: z.array(z.string()),
});
export type PatientProfile = z.infer<typeof PatientProfileSchema>;
