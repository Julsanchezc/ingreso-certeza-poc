import {
  INSURANCE_BRANCHES,
  STAGE_CODES,
} from './constants.mjs';
import { roundCurrency } from './commissionEngine.mjs';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBoundaryDate(rawDate, isEndBoundary = false) {
  if (!rawDate) return null;
  if (rawDate instanceof Date) {
    const ms = rawDate.getTime();
    if (Number.isNaN(ms)) throw new Error('Fecha de filtro inválida.');
    return ms;
  }
  const text = String(rawDate).trim();
  if (!text) return null;

  const isoCandidate = DATE_ONLY_RE.test(text)
    ? `${text}T${isEndBoundary ? '23:59:59.999Z' : '00:00:00.000Z'}`
    : text;

  const ms = new Date(isoCandidate).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Fecha de filtro inválida: "${rawDate}".`);
  }
  return ms;
}

/**
 * Calcula los indicadores ejecutivos y el desglose de estancamiento comercial (RFP 4.4).
 *
 * Invariante de embudo: `stagnation` particiona exclusivamente oportunidades activas no terminales
 * (`NUEVO`..`SOLICITUD_LLENADA`), garantizando que la suma de estancadas + ganadas + descartadas
 * iguale exactamente `totalOpportunities` sin contaminar métricas con negocios ya concluidos.
 */
export function computeDashboardKpis({
  dossiers = [],
  users = [],
  branches = INSURANCE_BRANCHES,
  filters = {},
} = {}) {
  const startMs = parseBoundaryDate(filters.startDate, false);
  const endMs = parseBoundaryDate(filters.endDate, true);
  if (startMs !== null && endMs !== null && startMs > endMs) {
    throw new Error('El rango de fechas es inválido: `startDate` supera a `endDate`.');
  }

  const filterAgentId =
    typeof filters.agentId === 'string' && filters.agentId.trim()
      ? filters.agentId.trim()
      : null;
  const filterReferrerId =
    typeof filters.referrerId === 'string' && filters.referrerId.trim()
      ? filters.referrerId.trim()
      : null;

  const usersById = new Map();
  for (const user of users) {
    if (user && user.id) {
      usersById.set(user.id, user);
    }
  }

  const matchedDossierIds = new Set();
  const activeReferrerIds = new Set();
  const activeAgentIds = new Set();
  const matchedEntries = [];

  for (const dossier of dossiers) {
    if (!dossier || !Array.isArray(dossier.opportunities)) continue;

    for (const opp of dossier.opportunities) {
      const effectiveReferrerId = opp.originalReferrerId ?? dossier.originalReferrerId;
      const effectiveAgentId = opp.assignedAgentId ?? dossier.assignedAgentId;
      const createdMs = new Date(opp.createdAt ?? dossier.createdAt).getTime();

      if (filterReferrerId && effectiveReferrerId !== filterReferrerId) continue;
      if (filterAgentId && effectiveAgentId !== filterAgentId) continue;
      if (startMs !== null && (Number.isNaN(createdMs) || createdMs < startMs)) continue;
      if (endMs !== null && (Number.isNaN(createdMs) || createdMs > endMs)) continue;

      matchedDossierIds.add(dossier.id);
      matchedEntries.push({
        dossierId: dossier.id,
        referrerId: effectiveReferrerId,
        agentId: effectiveAgentId,
        opportunity: opp,
      });

      if (effectiveReferrerId) {
        const refUser = usersById.get(effectiveReferrerId);
        if (!refUser || refUser.active !== false) {
          activeReferrerIds.add(effectiveReferrerId);
        }
      }

      if (effectiveAgentId) {
        const agtUser = usersById.get(effectiveAgentId);
        if (!agtUser || agtUser.active !== false) {
          activeAgentIds.add(effectiveAgentId);
        }
      }
    }
  }

  let closedWonCount = 0;
  let discardedCount = 0;
  let uncontactedCount = 0;
  let inCallCount = 0;
  let inAppointmentCount = 0;
  let inQuotationCount = 0;
  let inApplicationCount = 0;
  let crossSellOpportunities = 0;

  const branchAccumulators = new Map(
    branches.map((branch) => [
      branch.code,
      {
        branchCode: branch.code,
        branchName: branch.name,
        totalOpportunities: 0,
        closedWonCount: 0,
        totalClosedPremium: 0,
      },
    ])
  );

  const referrerAccumulators = new Map();

  for (const entry of matchedEntries) {
    const { dossierId, referrerId, opportunity } = entry;
    if (opportunity.isCrossSell) {
      crossSellOpportunities += 1;
    }

    if (!branchAccumulators.has(opportunity.branchCode)) {
      branchAccumulators.set(opportunity.branchCode, {
        branchCode: opportunity.branchCode,
        branchName: opportunity.branchCode,
        totalOpportunities: 0,
        closedWonCount: 0,
        totalClosedPremium: 0,
      });
    }
    const branchBucket = branchAccumulators.get(opportunity.branchCode);
    branchBucket.totalOpportunities += 1;

    if (referrerId && !referrerAccumulators.has(referrerId)) {
      const refUser = usersById.get(referrerId);
      referrerAccumulators.set(referrerId, {
        referrerId,
        referrerName: refUser?.fullName ?? refUser?.name ?? referrerId,
        dossierIds: new Set(),
        totalOpportunities: 0,
        closedWonCount: 0,
        confirmedCommissionAmount: 0,
        pipelineCommissionAmount: 0,
      });
    }

    const refBucket = referrerId ? referrerAccumulators.get(referrerId) : null;
    if (refBucket) {
      refBucket.dossierIds.add(dossierId);
      refBucket.totalOpportunities += 1;
    }

    const commissionAmount = Number(opportunity.commission?.commissionAmount ?? 0);

    switch (opportunity.stage) {
      case STAGE_CODES.NUEVO:
        uncontactedCount += 1;
        break;
      case STAGE_CODES.PRIMER_CONTACTO:
        inCallCount += 1;
        break;
      case STAGE_CODES.CITA_AGENDADA:
        inAppointmentCount += 1;
        break;
      case STAGE_CODES.EN_COTIZACION:
        inQuotationCount += 1;
        if (refBucket) {
          refBucket.pipelineCommissionAmount = roundCurrency(
            refBucket.pipelineCommissionAmount + commissionAmount
          );
        }
        break;
      case STAGE_CODES.SOLICITUD_LLENADA:
        inApplicationCount += 1;
        if (refBucket) {
          refBucket.pipelineCommissionAmount = roundCurrency(
            refBucket.pipelineCommissionAmount + commissionAmount
          );
        }
        break;
      case STAGE_CODES.POLIZA_PAGADA: {
        closedWonCount += 1;
        const settledPremium =
          Number(opportunity.finalPremium) > 0
            ? Number(opportunity.finalPremium)
            : Number(opportunity.estimatedPremium ?? 0);
        branchBucket.closedWonCount += 1;
        branchBucket.totalClosedPremium = roundCurrency(
          branchBucket.totalClosedPremium + settledPremium
        );
        if (refBucket) {
          refBucket.closedWonCount += 1;
          refBucket.confirmedCommissionAmount = roundCurrency(
            refBucket.confirmedCommissionAmount + commissionAmount
          );
        }
        break;
      }
      case STAGE_CODES.DESCARTADO:
        discardedCount += 1;
        break;
      default:
        break;
    }
  }

  const totalOpportunities = matchedEntries.length;
  const conversionRatePercent =
    totalOpportunities > 0
      ? roundCurrency((closedWonCount / totalOpportunities) * 100)
      : 0;

  const branchPerformance = Object.freeze(
    Array.from(branchAccumulators.values()).map((bucket) =>
      Object.freeze({
        branchCode: bucket.branchCode,
        branchName: bucket.branchName,
        totalOpportunities: bucket.totalOpportunities,
        closedWonCount: bucket.closedWonCount,
        conversionRatePercent:
          bucket.totalOpportunities > 0
            ? roundCurrency((bucket.closedWonCount / bucket.totalOpportunities) * 100)
            : 0,
        totalClosedPremium: bucket.totalClosedPremium,
      })
    )
  );

  const referrerRanking = Object.freeze(
    Array.from(referrerAccumulators.values())
      .map((bucket) => {
        const refConversion =
          bucket.totalOpportunities > 0
            ? roundCurrency((bucket.closedWonCount / bucket.totalOpportunities) * 100)
            : 0;
        return Object.freeze({
          referrerId: bucket.referrerId,
          referrerName: bucket.referrerName,
          totalDossiers: bucket.dossierIds.size,
          totalOpportunities: bucket.totalOpportunities,
          closedWonCount: bucket.closedWonCount,
          conversionRatePercent: refConversion,
          confirmedCommissionAmount: bucket.confirmedCommissionAmount,
          pipelineCommissionAmount: bucket.pipelineCommissionAmount,
        });
      })
      .sort((a, b) => {
        if (b.confirmedCommissionAmount !== a.confirmedCommissionAmount) {
          return b.confirmedCommissionAmount - a.confirmedCommissionAmount;
        }
        if (b.conversionRatePercent !== a.conversionRatePercent) {
          return b.conversionRatePercent - a.conversionRatePercent;
        }
        return b.closedWonCount - a.closedWonCount;
      })
  );

  return Object.freeze({
    activeForce: Object.freeze({
      activeReferrers: activeReferrerIds.size,
      activeAgents: activeAgentIds.size,
    }),
    prospectionVolume: Object.freeze({
      totalDossiers: matchedDossierIds.size,
      totalOpportunities,
      crossSellOpportunities,
    }),
    funnel: Object.freeze({
      conversionRatePercent,
      closedWonCount,
      discardedCount,
      stagnation: Object.freeze({
        uncontactedCount,
        inCallCount,
        inAppointmentCount,
        inQuotationCount,
        inApplicationCount,
      }),
    }),
    branchPerformance,
    referrerRanking,
  });
}
