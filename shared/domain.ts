import { z } from "zod";
export type Status = "OK" | "NOK" | null;
export type Role = "ADMIN" | "KEYUSER" | "EMPLOYEE";
export interface User {
  id: string;
  login: string;
  name: string;
  role: Role;
  active: boolean;
  version: number;
}
// SQL Server's uniqueidentifier can contain GUIDs outside RFC UUID version bits.
export const databaseIdSchema = z
  .guid("Некорректный идентификатор")
  .toLowerCase();
export const supSchema = z
  .string()
  .regex(/^[0-9]{7}$/, "SUP должен содержать ровно 7 цифр");
export function result(
  min: number,
  max: number,
  actual: number | null,
  equipment: number | null,
): Status {
  if (
    [actual, equipment].some(
      (value) => value !== null && (value < min || value > max),
    )
  )
    return "NOK";
  return actual === null || equipment === null ? null : "OK";
}
const temperature = z
  .number({ error: "Введите числовое значение температуры" })
  .finite()
  .min(-273.15, "Температура ниже абсолютного нуля")
  .max(10000, "Слишком высокая температура");
export const mixtureRangeError = "T min не может превышать T max";
export const mixtureSchema = z
  .object({
    name: z.string().trim().min(1, "Введите название").max(120),
    tMin: temperature,
    tMax: temperature,
    archived: z.boolean().optional(),
  })
  .refine((v) => v.tMin <= v.tMax, {
    message: mixtureRangeError,
    path: ["tMax"],
  });
export const recordSchema = z.object({
  sup: supSchema,
  mixtureId: databaseIdSchema,
  actual: temperature,
  equipment: temperature,
  version: z.number().int().positive().optional(),
});
export interface Mixture {
  id: string;
  name: string;
  tMin: number | null;
  tMax: number | null;
  archived: boolean;
  recordCount: number;
}
export interface Measurement {
  id: string;
  date: string;
  sup: string;
  mixtureId: string;
  mixtureName: string;
  tMin: number;
  tMax: number;
  actual: number | null;
  equipment: number | null;
  delta: number | null;
  legacyPending: boolean;
  actualMin: number | null;
  actualMax: number | null;
  status: Status;
  version: number;
  createdBy: string | null;
  authorName: string | null;
}
