import {
  COMMISSION_STATUS,
  INSURANCE_BRANCHES,
  STAGE_BY_CODE,
  STAGE_CODES,
} from './constants.mjs';
import {
  calculateOpportunityCommission,
  roundCurrency,
} from './commissionEngine.mjs';

const ALLOWED_RAW_CHARS_RE = /^[+]?[\d\s\-().]+$/;
const E164_STRICT_RE = /^\+[1-9]\d{9,14}$/;

function formatMxn(amount) {
  return `$${roundCurrency(amount).toFixed(2)} MXN`;
}

/**
 * Normaliza teléfonos al estándar E.164 exigido por Meta WhatsApp Cloud API.
 *
 * Resuelve la ambigüedad histórica en México tras la reforma IFT (prefijo móvil legado `+52 1`
 * de 13 dígitos frente a `+52` + 10 dígitos nacionales), valida numeración móvil/fija de 10
 * dígitos en Colombia (`+57`) y rechaza cadenas con extensiones alfabéticas antes de limpiar.
 */
export function normalizeWhatsAppPhone(rawPhone, defaultCountryCode = '52') {
  if (typeof rawPhone !== 'string') {
    throw new TypeError('El número de WhatsApp debe proporcionarse como cadena de texto.');
  }

  const trimmed = rawPhone.trim();
  if (!trimmed || !ALLOWED_RAW_CHARS_RE.test(trimmed)) {
    throw new Error(`Formato telefónico inválido para WhatsApp: "${rawPhone}".`);
  }

  const cleanDefaultCc = String(defaultCountryCode ?? '52')
    .trim()
    .replace(/^\+/, '');
  if (!/^[1-9]\d{0,2}$/.test(cleanDefaultCc)) {
    throw new Error(`Código de país predeterminado inválido: "${defaultCountryCode}".`);
  }

  let compact = trimmed.replace(/[\s\-().]/g, '');
  if (compact.startsWith('00') && compact.length > 10) {
    compact = `+${compact.slice(2)}`;
  }

  let digits;
  if (compact.startsWith('+')) {
    digits = compact.slice(1);
  } else if (compact.length === 10 && /^[1-9]\d{9}$/.test(compact)) {
    digits = `${cleanDefaultCc}${compact}`;
  } else if (compact.length === 13 && compact.startsWith('521')) {
    digits = `52${compact.slice(3)}`;
  } else if (
    compact.length === 12 &&
    (compact.startsWith('52') || compact.startsWith('57'))
  ) {
    digits = compact;
  } else {
    throw new Error(
      `Longitud telefónica inválida ("${rawPhone}"): ingrese 10 dígitos nacionales o formato E.164 (+52..., +57...).`
    );
  }

  // Unifica el prefijo móvil mexicano heredado (+521XXXXXXXXXX -> +52XXXXXXXXXX)
  // para evitar duplicidad de expedientes y fallos de entrega en plantillas HSM de Meta.
  if (digits.startsWith('521') && digits.length === 13) {
    digits = `52${digits.slice(3)}`;
  }

  if (digits.startsWith('52') && !/^52[1-9]\d{9}$/.test(digits)) {
    throw new Error(
      `Número de México inválido ("${rawPhone}"): se requieren exactamente 10 dígitos nacionales tras +52.`
    );
  }

  if (digits.startsWith('57') && !/^57[1-9]\d{9}$/.test(digits)) {
    throw new Error(
      `Número de Colombia inválido ("${rawPhone}"): se requieren exactamente 10 dígitos nacionales tras +57.`
    );
  }

  const normalized = `+${digits}`;
  if (!E164_STRICT_RE.test(normalized)) {
    throw new Error(`Número fuera del rango internacional E.164: "${rawPhone}".`);
  }

  return normalized;
}

/**
 * Construye los contratos de despacho asíncrono (Meta WhatsApp Cloud API + FCM/APNs Push)
 * disparados en cada transición de las 7 etapas comerciales (RFP 4.3).
 */
export function buildStageAlertPayload({
  dossier,
  opportunity,
  referrerName,
  referrerPhone,
  branches = INSURANCE_BRANCHES,
  languageCode = 'es_MX',
} = {}) {
  if (!dossier || typeof dossier.fullName !== 'string' || !dossier.fullName.trim()) {
    throw new Error('Se requiere un expediente válido con `fullName` para construir la alerta.');
  }
  if (!opportunity || !opportunity.stage || !opportunity.branchCode) {
    throw new Error('Se requiere una oportunidad válida con `stage` y `branchCode`.');
  }
  if (typeof referrerName !== 'string' || !referrerName.trim()) {
    throw new Error('Se requiere `referrerName` para personalizar la plantilla de WhatsApp.');
  }

  const recipientPhone = normalizeWhatsAppPhone(referrerPhone);
  const stageMeta = STAGE_BY_CODE[opportunity.stage];
  if (!stageMeta) {
    throw new Error(`Etapa desconocida en notificación: "${opportunity.stage}".`);
  }

  const branchMeta = branches.find((item) => item.code === opportunity.branchCode);
  if (!branchMeta) {
    throw new Error(`Ramo desconocido en notificación: "${opportunity.branchCode}".`);
  }

  const commission =
    opportunity.commission ??
    calculateOpportunityCommission({
      stage: opportunity.stage,
      estimatedPremium: opportunity.estimatedPremium,
      finalPremium: opportunity.finalPremium,
      referrerId: opportunity.originalReferrerId ?? dossier.originalReferrerId,
      branchCode: opportunity.branchCode,
      branches,
    });

  let commissionDetail;
  if (opportunity.stage === STAGE_CODES.POLIZA_PAGADA) {
    commissionDetail = `Comisión confirmada lista para cobro: ${formatMxn(commission.commissionAmount)} (${commission.ratePercent}%).`;
  } else if (opportunity.stage === STAGE_CODES.DESCARTADO) {
    commissionDetail = `Cierre sin comisión. Motivo reportado: ${opportunity.rejectionReason ?? 'No especificado'}.`;
  } else if (commission.commissionAmount > 0) {
    commissionDetail = `Comisión estimada en curso: ${formatMxn(commission.commissionAmount)} (${commission.ratePercent}%).`;
  } else {
    commissionDetail = `Tasa pactada: ${commission.ratePercent}% al cotizar prima.`;
  }

  const cleanProspectName = dossier.fullName.trim();
  const cleanReferrerName = referrerName.trim();
  const previewText = `Tu prospecto ${cleanProspectName} avanzó a '${stageMeta.label}' en ${branchMeta.name}. ${commissionDetail}`;

  const whatsappPayload = Object.freeze({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipientPhone,
    type: 'template',
    template: Object.freeze({
      name: 'estatus_prospecto_actualizado',
      language: Object.freeze({ code: languageCode }),
      components: Object.freeze([
        Object.freeze({
          type: 'body',
          parameters: Object.freeze([
            Object.freeze({ type: 'text', text: cleanReferrerName }),
            Object.freeze({ type: 'text', text: cleanProspectName }),
            Object.freeze({ type: 'text', text: stageMeta.label }),
            Object.freeze({ type: 'text', text: branchMeta.name }),
            Object.freeze({ type: 'text', text: commissionDetail }),
          ]),
        }),
      ]),
    }),
  });

  const pushPayload = Object.freeze({
    notification: Object.freeze({
      title: `${branchMeta.name}: ${stageMeta.label}`,
      body: previewText,
    }),
    data: Object.freeze({
      eventType: 'OPPORTUNITY_STAGE_UPDATED',
      dossierId: String(dossier.id ?? ''),
      opportunityId: String(opportunity.id ?? ''),
      branchCode: opportunity.branchCode,
      stage: opportunity.stage,
      commissionStatus: commission.commissionStatus,
      commissionAmount: String(commission.commissionAmount),
    }),
  });

  return Object.freeze({
    recipientPhone,
    previewText,
    whatsappPayload,
    pushPayload,
  });
}

/**
 * Compila el corte semanal automatizado para un prospectador (RFP 4.3):
 * 1. Monto confirmado listo para cobro (`POLIZA_PAGADA`).
 * 2. Monto estimado retenido en cotización o suscripción (`EN_COTIZACION` / `SOLICITUD_LLENADA`).
 * 3. Conteo de negocios activos aún pendientes de cotizar (`NUEVO`..`CITA_AGENDADA`).
 */
export function buildWeeklyDigestPayload({
  referrerId,
  referrerName,
  referrerPhone,
  dossiers = [],
  customRules = [],
  branches = INSURANCE_BRANCHES,
  weekLabel = 'Semana Actual',
  referenceDate = null,
  windowDays = 7,
  languageCode = 'es_MX',
} = {}) {
  if (typeof referrerId !== 'string' || !referrerId.trim()) {
    throw new Error('Se requiere `referrerId` para generar el corte semanal.');
  }
  if (typeof referrerName !== 'string' || !referrerName.trim()) {
    throw new Error('Se requiere `referrerName` para generar el corte semanal.');
  }

  const recipientPhone = normalizeWhatsAppPhone(referrerPhone);
  const cleanReferrerName = referrerName.trim();

  let windowEndMs = null;
  let windowStartMs = null;
  if (referenceDate !== null && referenceDate !== undefined) {
    windowEndMs = new Date(referenceDate).getTime();
    if (Number.isNaN(windowEndMs)) {
      throw new Error(`Fecha de referencia inválida en resumen semanal: "${referenceDate}".`);
    }
    windowStartMs = windowEndMs - Number(windowDays) * 24 * 60 * 60 * 1000;
  }

  let confirmedTotal = 0;
  let inQuotationTotal = 0;
  let pendingProspectsCount = 0;

  for (const dossier of dossiers) {
    if (!dossier || !Array.isArray(dossier.opportunities)) continue;

    for (const opp of dossier.opportunities) {
      const ownerReferrerId = opp.originalReferrerId ?? dossier.originalReferrerId;
      if (ownerReferrerId !== referrerId) continue;

      const commission = calculateOpportunityCommission({
        stage: opp.stage,
        estimatedPremium: opp.estimatedPremium,
        finalPremium: opp.finalPremium,
        referrerId: ownerReferrerId,
        branchCode: opp.branchCode,
        customRules,
        branches,
      });

      if (commission.commissionStatus === COMMISSION_STATUS.LISTA_PARA_COBRO) {
        if (windowEndMs !== null) {
          const closedTimestamp = new Date(opp.closedAt ?? opp.updatedAt ?? dossier.updatedAt).getTime();
          if (!Number.isNaN(closedTimestamp) && closedTimestamp >= windowStartMs && closedTimestamp <= windowEndMs) {
            confirmedTotal = roundCurrency(confirmedTotal + commission.commissionAmount);
          }
        } else {
          confirmedTotal = roundCurrency(confirmedTotal + commission.commissionAmount);
        }
      } else if (commission.commissionStatus === COMMISSION_STATUS.EN_PROCESO) {
        inQuotationTotal = roundCurrency(inQuotationTotal + commission.commissionAmount);
      } else if (commission.commissionStatus === COMMISSION_STATUS.PENDIENTE) {
        pendingProspectsCount += 1;
      }
    }
  }

  const summary = Object.freeze({
    confirmedAmountThisWeek: confirmedTotal,
    inQuotationEstimatedAmount: inQuotationTotal,
    pendingProspectsCount,
  });

  const previewText =
    `Resumen semanal (${weekLabel}) para ${cleanReferrerName}: ` +
    `${formatMxn(confirmedTotal)} confirmados listos para cobro, ` +
    `${formatMxn(inQuotationTotal)} estimados en cotización y ` +
    `${pendingProspectsCount} prospecto(s) pendiente(s) de avance.`;

  const whatsappPayload = Object.freeze({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipientPhone,
    type: 'template',
    template: Object.freeze({
      name: 'resumen_semanal_comisiones',
      language: Object.freeze({ code: languageCode }),
      components: Object.freeze([
        Object.freeze({
          type: 'body',
          parameters: Object.freeze([
            Object.freeze({ type: 'text', text: cleanReferrerName }),
            Object.freeze({ type: 'text', text: weekLabel }),
            Object.freeze({ type: 'text', text: formatMxn(confirmedTotal) }),
            Object.freeze({ type: 'text', text: formatMxn(inQuotationTotal) }),
            Object.freeze({ type: 'text', text: String(pendingProspectsCount) }),
          ]),
        }),
      ]),
    }),
  });

  return Object.freeze({
    referrerId,
    recipientPhone,
    weekLabel,
    summary,
    previewText,
    whatsappPayload,
  });
}
