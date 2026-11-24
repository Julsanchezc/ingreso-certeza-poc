import {
  COMMISSION_STATUS,
  INSURANCE_BRANCHES,
  STAGE_BY_CODE,
  STAGE_CODES,
} from './constants.mjs';

const EARLY_PIPELINE_STAGES = new Set([
  STAGE_CODES.NUEVO,
  STAGE_CODES.PRIMER_CONTACTO,
  STAGE_CODES.CITA_AGENDADA,
]);

const QUOTATION_PIPELINE_STAGES = new Set([
  STAGE_CODES.EN_COTIZACION,
  STAGE_CODES.SOLICITUD_LLENADA,
]);

/**
 * Normaliza importes monetarios y porcentajes a 2 decimales evitando deriva binaria IEEE-754
 * (ej. `18500 * 0.1255` o `0.1 + 0.2`) sin depender de librerías externas en el cliente web.
 */
export function roundCurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`Valor numérico inválido para redondeo financiero: ${value}`);
  }
  const sign = numeric < 0 ? -1 : 1;
  const absStr = Math.abs(numeric).toString();
  const scaled = absStr.includes('e')
    ? Math.abs(numeric) * 100
    : Number(`${absStr}e2`);
  const rounded = (sign * Math.round(scaled)) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Resuelve la tasa aplicable bajo jerarquía de especificidad (RFP 3.C):
 * un convenio activo `(referrerId, branchCode)` desplaza la tarifa general del ramo,
 * permitiendo escalonar incentivos por prospectador sin bifurcar el catálogo de productos.
 */
export function resolveCommissionRate({
  referrerId,
  branchCode,
  customRules = [],
  branches = INSURANCE_BRANCHES,
} = {}) {
  if (typeof branchCode !== 'string' || !branchCode.trim()) {
    throw new Error('Se requiere `branchCode` para resolver el porcentaje de comisión.');
  }

  const normalizedBranch = branchCode.trim().toUpperCase();
  const branch = branches.find((item) => item.code === normalizedBranch);
  if (!branch) {
    throw new Error(`Ramo asegurador desconocido: "${normalizedBranch}".`);
  }
  if (branch.active === false) {
    throw new Error(`El ramo "${normalizedBranch}" se encuentra inactivo para nuevas liquidaciones.`);
  }

  if (referrerId && Array.isArray(customRules)) {
    const specificRule = customRules.find(
      (rule) =>
        rule &&
        rule.active !== false &&
        rule.referrerId === referrerId &&
        String(rule.branchCode).toUpperCase() === normalizedBranch
    );

    if (specificRule) {
      const overrideRate = Number(specificRule.ratePercent ?? specificRule.commissionRate);
      if (!Number.isFinite(overrideRate) || overrideRate < 0 || overrideRate > 100) {
        throw new Error(
          `Regla personalizada inválida para (${referrerId}, ${normalizedBranch}): tasa fuera de rango [0, 100].`
        );
      }
      return roundCurrency(overrideRate);
    }
  }

  return roundCurrency(branch.defaultCommissionRate);
}

/**
 * Determina importe y exigibilidad jurídica de la comisión según la etapa comercial (RFP 4.2).
 *
 * Invariante contable: `LISTA_PARA_COBRO` se activa única y exclusivamente en `POLIZA_PAGADA`
 * (etapa 6), impidiendo dispersar fondos sobre solicitudes aún retenidas en suscripción médica
 * o recibos emitidos pendientes de cobro bancario.
 */
export function calculateOpportunityCommission({
  stage,
  estimatedPremium = 0,
  finalPremium = 0,
  referrerId,
  branchCode,
  customRules = [],
  branches = INSURANCE_BRANCHES,
} = {}) {
  const stageMeta = STAGE_BY_CODE[stage];
  if (!stageMeta) {
    throw new Error(`Etapa comercial inválida para cálculo de comisión: "${stage}".`);
  }

  const cleanEstimated = Number(estimatedPremium ?? 0);
  const cleanFinal = Number(finalPremium ?? 0);
  if (!Number.isFinite(cleanEstimated) || cleanEstimated < 0) {
    throw new Error('La prima estimada no puede ser negativa ni indefinida.');
  }
  if (!Number.isFinite(cleanFinal) || cleanFinal < 0) {
    throw new Error('La prima final emitida no puede ser negativa ni indefinida.');
  }

  const ratePercent = resolveCommissionRate({
    referrerId,
    branchCode,
    customRules,
    branches,
  });

  if (stage === STAGE_CODES.DESCARTADO) {
    return Object.freeze({
      ratePercent,
      baseAmount: 0,
      commissionAmount: 0,
      commissionStatus: COMMISSION_STATUS.CANCELADA,
    });
  }

  if (EARLY_PIPELINE_STAGES.has(stage)) {
    const baseAmount = cleanEstimated > 0 ? roundCurrency(cleanEstimated) : 0;
    const commissionAmount =
      baseAmount > 0 ? roundCurrency((baseAmount * ratePercent) / 100) : 0;

    return Object.freeze({
      ratePercent,
      baseAmount,
      commissionAmount,
      commissionStatus: COMMISSION_STATUS.PENDIENTE,
    });
  }

  if (QUOTATION_PIPELINE_STAGES.has(stage)) {
    const baseAmount = roundCurrency(cleanEstimated);
    const commissionAmount = roundCurrency((baseAmount * ratePercent) / 100);

    return Object.freeze({
      ratePercent,
      baseAmount,
      commissionAmount,
      commissionStatus: COMMISSION_STATUS.EN_PROCESO,
    });
  }

  // Etapa 6: POLIZA_PAGADA. Si suscripción ajustó la prima final respecto a la cotización,
  // la liquidación se asienta sobre la prima efectivamente pagada; de lo contrario usa el estimado.
  const settledBase = cleanFinal > 0 ? roundCurrency(cleanFinal) : roundCurrency(cleanEstimated);
  const settledCommission = roundCurrency((settledBase * ratePercent) / 100);

  return Object.freeze({
    ratePercent,
    baseAmount: settledBase,
    commissionAmount: settledCommission,
    commissionStatus: COMMISSION_STATUS.LISTA_PARA_COBRO,
  });
}
