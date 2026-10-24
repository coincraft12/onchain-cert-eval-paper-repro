/**
 * gradeThresholds 로 score → grade 분류.
 * 특허 C-1 §3-4.
 */

import type { Grade, GradeThresholds } from "../ruleset/types.js";

export function classifyGrade(score: number, thresholds: GradeThresholds): Grade {
  if (thresholds.professional !== undefined && score >= thresholds.professional) {
    return "Professional";
  }
  if (thresholds.associate !== undefined && score >= thresholds.associate) {
    return "Associate";
  }
  if (score >= thresholds.basic) return "Basic";
  return "Below";
}
