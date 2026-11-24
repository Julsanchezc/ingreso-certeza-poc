/**
 * Controlador interactivo del simulador web IngresoCerteza.
 *
 * Consume directamente el núcleo puro de dominio (`../src/domain/index.mjs`) sin duplicar
 * fórmulas de comisión, validaciones telefónicas E.164 ni reglas de transición de etapas.
 * Todo texto dinámico pasa por `escapeHtml` antes de inyectarse al DOM para impedir XSS.
 */
import {
  COMMERCIAL_STAGES,
  COMMISSION_STATUS,
  ROLES,
  STAGE_BY_CODE,
  STAGE_CODES,
  addCrossSellOpportunity,
  buildStageAlertPayload,
  buildWeeklyDigestPayload,
  calculateOpportunityCommission,
  computeDashboardKpis,
  createDemoDataset,
  createProspectDossier,
  normalizeWhatsAppPhone,
  registerInsuranceBranch,
  resolveCommissionRate,
  roundCurrency,
  transitionDossierOpportunity,
  transitionOpportunityStage,
} from '../src/domain/index.mjs';

const CURRENCY_FORMATTER = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PERCENT_FORMATTER = new Intl.NumberFormat('es-MX', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Escapa caracteres especiales HTML en cualquier entrada de usuario (nombres, notas, motivos)
 * antes de componer plantillas para mitigar inyección XSS reflejada o almacenada en memoria.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Neutraliza fórmulas potencialmente ejecutables en hojas de cálculo (`=`, `+`, `-`, `@`)
 * y aplica comillas RFC 4180 para exportación CSV segura en Excel.
 */
function sanitizeCsvCell(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const neutralized = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function formatMxn(amount) {
  return CURRENCY_FORMATTER.format(roundCurrency(Number(amount || 0)));
}

function formatPercent(value) {
  return `${PERCENT_FORMATTER.format(roundCurrency(Number(value || 0)))}%`;
}

function formatDateTime(isoString) {
  if (!isoString) return 'Sin registro';
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return String(isoString);
  return DATE_TIME_FORMATTER.format(parsed);
}

/**
 * Estado reactivo en memoria inicializado a partir de `createDemoDataset()`.
 */
const state = {
  activeTab: 'prospectador',
  branches: [],
  users: [],
  customRules: [],
  dossiers: [],
  activeReferrerId: 'ref-sofia',
  activeAgentId: 'agt-valeria',
  agentStageFilter: 'ALL',
  openCrossSellDossierIds: new Set(),
  outboxEvents: [],
  selectedOutboxEventId: null,
  outboxJsonMode: 'whatsapp',
  lastWeeklyDigest: null,
  adminFilters: {
    agentId: '',
    referrerId: '',
    startDate: '',
    endDate: '',
  },
  dossierSeq: 6,
  outboxSeq: 1,
  toastTimer: null,
};

function getUsersByRole(role) {
  return state.users.filter((user) => user.role === role && user.active !== false);
}

function findUserById(userId) {
  return state.users.find((user) => user.id === userId) || null;
}

function findBranchByCode(branchCode) {
  return state.branches.find((branch) => branch.code === branchCode) || null;
}

function getCommissionBadgeMeta(status) {
  switch (status) {
    case COMMISSION_STATUS.LISTA_PARA_COBRO:
      return { label: 'Lista para cobro', pillClass: 'pill-emerald' };
    case COMMISSION_STATUS.EN_PROCESO:
      return { label: 'En cotización / suscripción', pillClass: 'pill-amber' };
    case COMMISSION_STATUS.CANCELADA:
      return { label: 'Sin comisión (descartado)', pillClass: 'pill-danger' };
    default:
      return { label: 'Pendiente de cotizar', pillClass: 'pill-neutral' };
  }
}

function getSuggestedNextStage(currentStage) {
  const ordered = [
    STAGE_CODES.NUEVO,
    STAGE_CODES.PRIMER_CONTACTO,
    STAGE_CODES.CITA_AGENDADA,
    STAGE_CODES.EN_COTIZACION,
    STAGE_CODES.SOLICITUD_LLENADA,
    STAGE_CODES.POLIZA_PAGADA,
  ];
  const idx = ordered.indexOf(currentStage);
  if (idx >= 0 && idx < ordered.length - 1) {
    return ordered[idx + 1];
  }
  return currentStage;
}

/**
 * Hidrata el estado inicial y convierte `sampleAlerts` del dominio en eventos inspeccionables
 * del Transactional Outbox para que el panel del Vendedor tenga trazas reales desde el arranque.
 */
function initializeDemoState() {
  const snapshot = createDemoDataset();
  state.branches = [...snapshot.branches];
  state.users = [...snapshot.users];
  state.customRules = snapshot.customRules.map((rule) => ({ ...rule }));
  state.dossiers = [...snapshot.dossiers];
  state.openCrossSellDossierIds.clear();
  state.lastWeeklyDigest = null;
  state.dossierSeq = snapshot.dossiers.length + 1;
  state.outboxSeq = 1;

  const referrers = getUsersByRole(ROLES.PROSPECTADOR);
  const agents = getUsersByRole(ROLES.VENDEDOR);
  state.activeReferrerId = referrers[0]?.id || 'ref-sofia';
  state.activeAgentId = agents[0]?.id || 'agt-valeria';
  state.agentStageFilter = 'ALL';
  state.adminFilters = { agentId: '', referrerId: '', startDate: '', endDate: '' };

  state.outboxEvents = snapshot.sampleAlerts.map((alertPayload, idx) => ({
    id: `evt-seed-${idx + 1}`,
    createdAt: new Date(Date.now() - (idx + 1) * 3600 * 1000).toISOString(),
    referrerName:
      alertPayload.whatsappPayload?.template?.components?.[0]?.parameters?.[0]?.text ||
      'Prospectador',
    prospectName:
      alertPayload.whatsappPayload?.template?.components?.[0]?.parameters?.[1]?.text ||
      'Prospecto',
    stageLabel:
      alertPayload.whatsappPayload?.template?.components?.[0]?.parameters?.[2]?.text || '',
    branchName:
      alertPayload.whatsappPayload?.template?.components?.[0]?.parameters?.[3]?.text || '',
    payload: alertPayload,
  }));
  state.selectedOutboxEventId = state.outboxEvents[0]?.id || null;
}

function pushOutboxAlert({ dossier, opportunity }) {
  const referrer = findUserById(opportunity.originalReferrerId || dossier.originalReferrerId);
  if (!referrer) return null;

  const alertPayload = buildStageAlertPayload({
    dossier,
    opportunity,
    referrerName: referrer.fullName,
    referrerPhone: referrer.phone,
    branches: state.branches,
  });

  const branchMeta = findBranchByCode(opportunity.branchCode);
  const stageMeta = STAGE_BY_CODE[opportunity.stage];
  const eventRecord = {
    id: `evt-live-${state.outboxSeq++}`,
    createdAt: new Date().toISOString(),
    referrerName: referrer.fullName,
    prospectName: dossier.fullName,
    stageLabel: stageMeta ? stageMeta.label : opportunity.stage,
    branchName: branchMeta ? branchMeta.name : opportunity.branchCode,
    payload: alertPayload,
  };

  state.outboxEvents = [eventRecord, ...state.outboxEvents];
  state.selectedOutboxEventId = eventRecord.id;
  return eventRecord;
}

/**
 * Recalcula comisiones proyectadas únicamente en oportunidades abiertas cuando Administración
 * modifica convenios (`customRules`). Las pólizas ya pagadas (`POLIZA_PAGADA`) permanecen intactas
 * para respetar la inmutabilidad contable de liquidaciones cerradas.
 */
function recalculateOpenPipelineCommissions() {
  state.dossiers = state.dossiers.map((dossier) => {
    const nextOpportunities = dossier.opportunities.map((opp) => {
      const stageMeta = STAGE_BY_CODE[opp.stage];
      if (stageMeta?.isTerminal) return opp;

      const updatedCommission = calculateOpportunityCommission({
        stage: opp.stage,
        estimatedPremium: opp.estimatedPremium,
        finalPremium: opp.finalPremium,
        referrerId: opp.originalReferrerId || dossier.originalReferrerId,
        branchCode: opp.branchCode,
        customRules: state.customRules,
        branches: state.branches,
      });

      return Object.freeze({
        ...opp,
        commission: updatedCommission,
      });
    });

    return Object.freeze({
      ...dossier,
      opportunities: Object.freeze(nextOpportunities),
    });
  });
}

function showToast(message, isWarning = false) {
  const banner = document.getElementById('global-toast');
  if (!banner) return;

  banner.textContent = message;
  banner.classList.toggle('is-warning', Boolean(isWarning));
  banner.hidden = false;

  if (state.toastTimer) {
    window.clearTimeout(state.toastTimer);
  }
  state.toastTimer = window.setTimeout(() => {
    banner.hidden = true;
  }, 5200);
}

/* ============================================================================
   CONMUTACIÓN ACCESIBLE DE PESTAÑAS Y SINCRONIZACIÓN DE URL
   ============================================================================ */
function setActiveTab(tabKey, focusTrigger = false) {
  const validTabs = ['prospectador', 'vendedor', 'admin'];
  const resolved = validTabs.includes(tabKey) ? tabKey : 'prospectador';
  state.activeTab = resolved;

  const triggers = document.querySelectorAll('[role="tab"][data-tab]');
  triggers.forEach((btn) => {
    const isMatch = btn.dataset.tab === resolved;
    btn.classList.toggle('is-active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    btn.setAttribute('tabindex', isMatch ? '0' : '-1');
    if (isMatch && focusTrigger) {
      btn.focus();
    }
  });

  validTabs.forEach((key) => {
    const panel = document.getElementById(`panel-${key}`);
    if (panel) {
      panel.hidden = key !== resolved;
    }
  });

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('vista', resolved);
  window.history.replaceState({}, '', nextUrl);
}

/* ============================================================================
   RENDERIZADO DE SELECTORES GLOBALES
   ============================================================================ */
function syncStaticControls() {
  const referrers = getUsersByRole(ROLES.PROSPECTADOR);
  const agents = getUsersByRole(ROLES.VENDEDOR);

  // Selector de Prospectador activo (Pestaña 1)
  const selectReferrer = document.getElementById('select-referrer');
  if (selectReferrer) {
    selectReferrer.innerHTML = referrers
      .map(
        (ref) =>
          `<option value="${escapeHtml(ref.id)}" ${
            ref.id === state.activeReferrerId ? 'selected' : ''
          }>${escapeHtml(ref.fullName)} (${escapeHtml(ref.phone)})</option>`
      )
      .join('');
  }

  // Selector de Agente asignado en formulario de alta (Pestaña 1)
  const selectProspectAgent = document.getElementById('select-prospect-agent');
  if (selectProspectAgent) {
    const currentVal = selectProspectAgent.value || agents[0]?.id || '';
    selectProspectAgent.innerHTML = agents
      .map(
        (agt) =>
          `<option value="${escapeHtml(agt.id)}" ${
            agt.id === currentVal ? 'selected' : ''
          }>${escapeHtml(agt.fullName)}</option>`
      )
      .join('');
  }

  // Selector de Vendedor activo (Pestaña 2)
  const selectAgent = document.getElementById('select-agent');
  if (selectAgent) {
    selectAgent.innerHTML = agents
      .map(
        (agt) =>
          `<option value="${escapeHtml(agt.id)}" ${
            agt.id === state.activeAgentId ? 'selected' : ''
          }>${escapeHtml(agt.fullName)} (${escapeHtml(agt.email)})</option>`
      )
      .join('');
  }

  // Filtro de etapa para el Vendedor (Pestaña 2)
  const selectStageFilter = document.getElementById('select-agent-stage-filter');
  if (selectStageFilter) {
    const stageOptions = COMMERCIAL_STAGES.map(
      (st) =>
        `<option value="${escapeHtml(st.code)}" ${
          state.agentStageFilter === st.code ? 'selected' : ''
        }>Etapa ${st.stepNumber}: ${escapeHtml(st.label)}</option>`
    ).join('');
    selectStageFilter.innerHTML = `<option value="ALL" ${
      state.agentStageFilter === 'ALL' ? 'selected' : ''
    }>Todas las etapas (${COMMERCIAL_STAGES.length})</option>${stageOptions}`;
  }

  // Filtros y selectores de Administración (Pestaña 3)
  const filterAgent = document.getElementById('filter-agent');
  if (filterAgent) {
    filterAgent.innerHTML =
      `<option value="">Todos los vendedores (${agents.length})</option>` +
      agents
        .map(
          (agt) =>
            `<option value="${escapeHtml(agt.id)}" ${
              state.adminFilters.agentId === agt.id ? 'selected' : ''
            }>${escapeHtml(agt.fullName)}</option>`
        )
        .join('');
  }

  const filterReferrer = document.getElementById('filter-referrer');
  if (filterReferrer) {
    filterReferrer.innerHTML =
      `<option value="">Todos los prospectadores (${referrers.length})</option>` +
      referrers
        .map(
          (ref) =>
            `<option value="${escapeHtml(ref.id)}" ${
              state.adminFilters.referrerId === ref.id ? 'selected' : ''
            }>${escapeHtml(ref.fullName)}</option>`
        )
        .join('');
  }

  const ruleReferrer = document.getElementById('rule-referrer');
  if (ruleReferrer) {
    const prevRef = ruleReferrer.value || referrers[0]?.id || '';
    ruleReferrer.innerHTML = referrers
      .map(
        (ref) =>
          `<option value="${escapeHtml(ref.id)}" ${
            ref.id === prevRef ? 'selected' : ''
          }>${escapeHtml(ref.fullName)}</option>`
      )
      .join('');
  }

  const ruleBranch = document.getElementById('rule-branch');
  if (ruleBranch) {
    const activeBranches = state.branches.filter((b) => b.active !== false);
    const prevBranch = ruleBranch.value || activeBranches[0]?.code || '';
    ruleBranch.innerHTML = activeBranches
      .map(
        (branch) =>
          `<option value="${escapeHtml(branch.code)}" ${
            branch.code === prevBranch ? 'selected' : ''
          }>${escapeHtml(branch.name)} (Base ${formatPercent(branch.defaultCommissionRate)})</option>`
      )
      .join('');
  }
}

/* ============================================================================
   RENDERIZADO PESTAÑA 1: APP MÓVIL — PROSPECTADOR
   ============================================================================ */
function renderStageStepperHtml(currentStageCode) {
  const currentMeta = STAGE_BY_CODE[currentStageCode];
  const currentStep = currentMeta ? currentMeta.stepNumber : 1;

  return `<div class="stage-stepper" aria-label="Progreso en 7 etapas comerciales: etapa actual ${escapeHtml(
    currentMeta?.label || currentStageCode
  )}">
    ${COMMERCIAL_STAGES.map((stage) => {
      let stateClass = '';
      if (currentStageCode === STAGE_CODES.POLIZA_PAGADA) {
        if (stage.code === STAGE_CODES.POLIZA_PAGADA) {
          stateClass = 'is-won';
        } else if (stage.stepNumber < 6) {
          stateClass = 'is-passed';
        }
      } else if (currentStageCode === STAGE_CODES.DESCARTADO) {
        if (stage.code === STAGE_CODES.DESCARTADO) {
          stateClass = 'is-discarded';
        }
      } else if (stage.code === currentStageCode) {
        stateClass = 'is-current';
      } else if (stage.stepNumber < currentStep) {
        stateClass = 'is-passed';
      }

      return `<div class="stage-step ${stateClass}" title="Etapa ${stage.stepNumber}: ${escapeHtml(
        stage.label
      )}">
        <span class="stage-index">${stage.stepNumber}/7</span>
        <span class="stage-step-name">${escapeHtml(stage.label)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderProspectadorView() {
  const activeReferrer = findUserById(state.activeReferrerId);
  if (!activeReferrer) return;

  // Aislamiento estricto RBAC: el prospectador únicamente visualiza expedientes donde es el autor original
  const ownDossiers = state.dossiers.filter(
    (dos) =>
      dos.originalReferrerId === activeReferrer.id ||
      dos.opportunities.some((opp) => opp.originalReferrerId === activeReferrer.id)
  );

  const rbacBadge = document.getElementById('referrer-rbac-badge');
  if (rbacBadge) {
    rbacBadge.textContent = `Acceso restringido a ${ownDossiers.length} expediente(s) propios`;
  }

  let readyAmount = 0;
  let readyCount = 0;
  let inProcessAmount = 0;
  let inProcessCount = 0;
  let activeOpportunitiesCount = 0;
  let crossSellCount = 0;

  ownDossiers.forEach((dossier) => {
    dossier.opportunities.forEach((opp) => {
      if ((opp.originalReferrerId || dossier.originalReferrerId) !== activeReferrer.id) return;
      if (opp.isCrossSell) crossSellCount += 1;

      const stageMeta = STAGE_BY_CODE[opp.stage];
      if (!stageMeta?.isTerminal) {
        activeOpportunitiesCount += 1;
      }

      const comm = opp.commission;
      if (comm?.commissionStatus === COMMISSION_STATUS.LISTA_PARA_COBRO) {
        readyAmount = roundCurrency(readyAmount + comm.commissionAmount);
        readyCount += 1;
      } else if (comm?.commissionStatus === COMMISSION_STATUS.EN_PROCESO) {
        inProcessAmount = roundCurrency(inProcessAmount + comm.commissionAmount);
        inProcessCount += 1;
      }
    });
  });

  // Tarjetas de billetera
  const walletContainer = document.getElementById('referrer-wallet-cards');
  if (walletContainer) {
    walletContainer.innerHTML = `
      <article class="kpi-card accent-emerald">
        <span class="kpi-label">Comisiones listas para cobro</span>
        <strong class="kpi-value is-emerald">${escapeHtml(formatMxn(readyAmount))}</strong>
        <span class="kpi-foot tabular">${readyCount} póliza(s) emitida(s) y pagada(s)</span>
      </article>
      <article class="kpi-card accent-amber">
        <span class="kpi-label">En proceso de cotización</span>
        <strong class="kpi-value is-amber">${escapeHtml(formatMxn(inProcessAmount))}</strong>
        <span class="kpi-foot tabular">${inProcessCount} oportunidad(es) cotizadas o en suscripción</span>
      </article>
      <article class="kpi-card accent-blue">
        <span class="kpi-label">Prospectos activos en seguimiento</span>
        <strong class="kpi-value">${activeOpportunitiesCount}</strong>
        <span class="kpi-foot tabular">${ownDossiers.length} expediente(s) totales · ${crossSellCount} venta(s) cruzada(s)</span>
      </article>
    `;
  }

  // Tira de porcentajes vigentes por ramo para el prospectador activo
  const ratesStrip = document.getElementById('referrer-rates-strip');
  if (ratesStrip) {
    const activeBranches = state.branches.filter((b) => b.active !== false);
    ratesStrip.innerHTML = activeBranches
      .map((branch) => {
        const effectiveRate = resolveCommissionRate({
          referrerId: activeReferrer.id,
          branchCode: branch.code,
          customRules: state.customRules,
          branches: state.branches,
        });
        const isPreferential = effectiveRate !== roundCurrency(branch.defaultCommissionRate);
        return `<span class="rate-chip tabular ${isPreferential ? 'is-preferential' : ''}">
          <span>${escapeHtml(branch.name)}</span>
          <strong>${escapeHtml(formatPercent(effectiveRate))}</strong>
          ${isPreferential ? '<span>(Convenio)</span>' : ''}
        </span>`;
      })
      .join('');
  }

  // Checkboxes multi-ramo en el formulario de registro preservando selecciones previas
  const branchesContainer = document.getElementById('prospect-branches-list');
  if (branchesContainer) {
    const previouslyChecked = new Set(
      Array.from(
        branchesContainer.querySelectorAll('input[name="initialBranches"]:checked')
      ).map((el) => el.value)
    );
    const activeBranches = state.branches.filter((b) => b.active !== false);

    branchesContainer.innerHTML = activeBranches
      .map((branch, idx) => {
        const rate = resolveCommissionRate({
          referrerId: activeReferrer.id,
          branchCode: branch.code,
          customRules: state.customRules,
          branches: state.branches,
        });
        const checkedAttr =
          previouslyChecked.size > 0
            ? previouslyChecked.has(branch.code)
              ? 'checked'
              : ''
            : idx === 0
              ? 'checked'
              : '';
        const inputId = `chk-branch-${branch.code.toLowerCase()}`;
        return `<label class="branch-check-item" for="${escapeHtml(inputId)}">
          <input
            type="checkbox"
            id="${escapeHtml(inputId)}"
            name="initialBranches"
            value="${escapeHtml(branch.code)}"
            ${checkedAttr}
          />
          <span class="branch-check-meta">
            <span>${escapeHtml(branch.name)}</span>
            <span class="branch-check-rate tabular">Tu comisión: ${escapeHtml(formatPercent(rate))}</span>
          </span>
        </label>`;
      })
      .join('');
  }

  // Conteo y listado del embudo propio
  const funnelCount = document.getElementById('referrer-funnel-count');
  if (funnelCount) {
    const totalOpps = ownDossiers.reduce((acc, dos) => acc + dos.opportunities.length, 0);
    funnelCount.textContent = `${ownDossiers.length} expedientes · ${totalOpps} ramos`;
  }

  const listEl = document.getElementById('referrer-dossiers-list');
  if (!listEl) return;

  if (ownDossiers.length === 0) {
    listEl.innerHTML = `<div class="empty-state">Aún no tienes prospectos registrados bajo tu cuenta. Usa el formulario lateral para dar de alta el primero.</div>`;
    return;
  }

  listEl.innerHTML = ownDossiers
    .map((dossier) => {
      const assignedAgent = findUserById(dossier.assignedAgentId);
      const opportunitiesHtml = dossier.opportunities
        .filter((opp) => (opp.originalReferrerId || dossier.originalReferrerId) === activeReferrer.id)
        .map((opp) => {
          const branchMeta = findBranchByCode(opp.branchCode);
          const stageMeta = STAGE_BY_CODE[opp.stage];
          const badgeMeta = getCommissionBadgeMeta(opp.commission?.commissionStatus);
          const lastAudit = opp.auditTrail?.[opp.auditTrail.length - 1];

          let financialDetail = `Tasa aplicable: ${formatPercent(opp.commission?.ratePercent || 0)}`;
          if (opp.stage === STAGE_CODES.POLIZA_PAGADA) {
            financialDetail = `Prima pagada ${formatMxn(opp.finalPremium || opp.estimatedPremium)} · Comisión lista: ${formatMxn(opp.commission?.commissionAmount)}`;
          } else if (opp.commission?.commissionAmount > 0) {
            financialDetail = `Prima cotizada ${formatMxn(opp.estimatedPremium)} · Comisión estimada: ${formatMxn(opp.commission?.commissionAmount)} (${formatPercent(opp.commission?.ratePercent)})`;
          }

          return `<div class="opportunity-row">
            <div class="opportunity-top">
              <div class="opportunity-branch-group">
                <span class="opportunity-branch-title">${escapeHtml(
                  branchMeta ? branchMeta.name : opp.branchCode
                )}</span>
                ${
                  opp.isCrossSell
                    ? `<span class="pill pill-blue">Venta cruzada · Comisión protegida</span>`
                    : `<span class="pill pill-neutral">Ramo inicial</span>`
                }
              </div>
              <div class="opportunity-commission-box tabular">
                <span class="pill ${badgeMeta.pillClass}">${escapeHtml(badgeMeta.label)}</span>
                <strong>${escapeHtml(formatMxn(opp.commission?.commissionAmount || 0))}</strong>
              </div>
            </div>

            ${renderStageStepperHtml(opp.stage)}

            <div class="section-caption tabular">
              <strong>Estado actual:</strong> ${escapeHtml(stageMeta ? stageMeta.label : opp.stage)} — ${escapeHtml(financialDetail)}
              ${
                opp.stage === STAGE_CODES.DESCARTADO && opp.rejectionReason
                  ? `<br /><strong>Motivo reportado por el agente:</strong> ${escapeHtml(opp.rejectionReason)}`
                  : ''
              }
              ${
                lastAudit?.notes && opp.stage !== STAGE_CODES.DESCARTADO
                  ? `<br /><span>Última bitácora (${escapeHtml(formatDateTime(lastAudit.timestamp))}): ${escapeHtml(lastAudit.notes)}</span>`
                  : ''
              }
            </div>
          </div>`;
        })
        .join('');

      return `<article class="dossier-surface">
        <div class="dossier-head">
          <div>
            <h3 class="dossier-title">${escapeHtml(dossier.fullName)}</h3>
            <ul class="dossier-meta-list tabular">
              <li>Expediente: <strong>${escapeHtml(dossier.id)}</strong></li>
              <li>WhatsApp: ${escapeHtml(dossier.phone)}</li>
              ${dossier.email ? `<li>Correo: ${escapeHtml(dossier.email)}</li>` : ''}
              <li>Ejecutivo: ${escapeHtml(assignedAgent ? assignedAgent.fullName : 'Por asignar')}</li>
            </ul>
          </div>
          <span class="pill pill-neutral tabular">Alta: ${escapeHtml(formatDateTime(dossier.createdAt))}</span>
        </div>
        <div class="opportunity-list">
          ${opportunitiesHtml}
        </div>
      </article>`;
    })
    .join('');

  // Si el panel de resumen semanal está visible, actualizarlo con el prospectador activo
  const digestPanel = document.getElementById('weekly-digest-panel');
  if (digestPanel && !digestPanel.hidden) {
    renderWeeklyDigestSimulation();
  }
}

function renderWeeklyDigestSimulation() {
  const activeReferrer = findUserById(state.activeReferrerId);
  const digestPanel = document.getElementById('weekly-digest-panel');
  const digestBody = document.getElementById('weekly-digest-body');
  if (!activeReferrer || !digestPanel || !digestBody) return;

  const digest = buildWeeklyDigestPayload({
    referrerId: activeReferrer.id,
    referrerName: activeReferrer.fullName,
    referrerPhone: activeReferrer.phone,
    dossiers: state.dossiers,
    customRules: state.customRules,
    branches: state.branches,
    weekLabel: 'Corte Semanal en Curso',
  });

  state.lastWeeklyDigest = digest;
  digestPanel.hidden = false;

  digestBody.innerHTML = `
    <div class="wa-preview-box">
      <div class="wa-header tabular">
        <span>WhatsApp Business · Meta Cloud API</span>
        <span>Destino: ${escapeHtml(digest.recipientPhone)}</span>
      </div>
      <div class="wa-bubble">
        <p style="margin: 0 0 0.5rem;">${escapeHtml(digest.previewText)}</p>
        <ul class="dossier-meta-list tabular" style="margin-top: 0.5rem;">
          <li>Confirmado cobrable: <strong>${escapeHtml(formatMxn(digest.summary.confirmedAmountThisWeek))}</strong></li>
          <li>En cotización: <strong>${escapeHtml(formatMxn(digest.summary.inQuotationEstimatedAmount))}</strong></li>
          <li>Pendientes de cotizar: <strong>${digest.summary.pendingProspectsCount}</strong></li>
        </ul>
      </div>
    </div>
    <div>
      <pre class="json-terminal"><code translate="no">${escapeHtml(
        JSON.stringify(digest.whatsappPayload, null, 2)
      )}</code></pre>
    </div>
  `;
}

/* ============================================================================
   RENDERIZADO PESTAÑA 2: APP MÓVIL — VENDEDOR + TRANSACTIONAL OUTBOX
   ============================================================================ */
function renderVendedorView() {
  const activeAgent = findUserById(state.activeAgentId);
  if (!activeAgent) return;

  const agentDossiers = state.dossiers.filter(
    (dossier) =>
      dossier.assignedAgentId === activeAgent.id ||
      dossier.opportunities.some((opp) => opp.assignedAgentId === activeAgent.id)
  );

  let openCount = 0;
  let totalAssignedOpps = 0;
  agentDossiers.forEach((dos) => {
    dos.opportunities.forEach((opp) => {
      const effectiveAgent = opp.assignedAgentId || dos.assignedAgentId;
      if (effectiveAgent !== activeAgent.id) return;
      totalAssignedOpps += 1;
      if (!STAGE_BY_CODE[opp.stage]?.isTerminal) openCount += 1;
    });
  });

  const workloadBadge = document.getElementById('agent-workload-badge');
  if (workloadBadge) {
    workloadBadge.textContent = `${openCount} abierta(s) · ${totalAssignedOpps} oportunidades totales`;
  }

  const listEl = document.getElementById('agent-dossiers-list');
  if (!listEl) return;

  const filteredDossiers = agentDossiers.filter((dos) =>
    dos.opportunities.some((opp) => {
      const belongsToAgent = (opp.assignedAgentId || dos.assignedAgentId) === activeAgent.id;
      if (!belongsToAgent) return false;
      return state.agentStageFilter === 'ALL' || opp.stage === state.agentStageFilter;
    })
  );

  if (filteredDossiers.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No hay expedientes asignados a ${escapeHtml(
      activeAgent.fullName
    )} con el filtro de etapa seleccionado.</div>`;
  } else {
    listEl.innerHTML = filteredDossiers
      .map((dossier) => renderVendorDossierCardHtml(dossier, activeAgent))
      .join('');
  }

  renderOutboxInspector();
}

function renderVendorDossierCardHtml(dossier, activeAgent) {
  const originalReferrer = findUserById(dossier.originalReferrerId);
  const isCrossSellOpen = state.openCrossSellDossierIds.has(dossier.id);
  const activeBranches = state.branches.filter((b) => b.active !== false);

  const openBranchCodes = new Set(
    dossier.opportunities
      .filter((opp) => !STAGE_BY_CODE[opp.stage]?.isTerminal)
      .map((opp) => opp.branchCode)
  );

  const crossSellOptionsHtml = activeBranches
    .map((branch) => {
      const rate = resolveCommissionRate({
        referrerId: dossier.originalReferrerId,
        branchCode: branch.code,
        customRules: state.customRules,
        branches: state.branches,
      });
      const alreadyOpenTag = openBranchCodes.has(branch.code) ? ' [Ya activo en expediente]' : '';
      return `<option value="${escapeHtml(branch.code)}" ${
        !openBranchCodes.has(branch.code) ? '' : ''
      }>${escapeHtml(branch.name)} — Comisión referidor ${formatPercent(rate)}${escapeHtml(
        alreadyOpenTag
      )}</option>`;
    })
    .join('');

  const opportunitiesHtml = dossier.opportunities
    .filter((opp) => {
      const belongs = (opp.assignedAgentId || dossier.assignedAgentId) === activeAgent.id;
      if (!belongs) return false;
      return state.agentStageFilter === 'ALL' || opp.stage === state.agentStageFilter;
    })
    .map((opp) => renderVendorOpportunityRowHtml(dossier, opp))
    .join('');

  return `<article class="dossier-surface" data-dossier-id="${escapeHtml(dossier.id)}">
    <div class="dossier-head">
      <div>
        <h3 class="dossier-title">${escapeHtml(dossier.fullName)}</h3>
        <ul class="dossier-meta-list tabular">
          <li>Expediente: <strong>${escapeHtml(dossier.id)}</strong></li>
          <li>WhatsApp E.164: <strong>${escapeHtml(dossier.phone)}</strong></li>
          ${dossier.email ? `<li>Correo: ${escapeHtml(dossier.email)}</li>` : ''}
        </ul>
      </div>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-action="toggle-cross-sell"
        data-dossier-id="${escapeHtml(dossier.id)}"
        aria-expanded="${isCrossSellOpen ? 'true' : 'false'}"
      >
        + Venta Cruzada (Multi-ramo)
      </button>
    </div>

    <div class="attribution-banner">
      <span>
        Referidor original sellado:
        <strong>${escapeHtml(originalReferrer ? originalReferrer.fullName : dossier.originalReferrerId)}</strong>
        (<code translate="no">${escapeHtml(dossier.originalReferrerId)}</code>)
      </span>
      <span>Toda póliza adicional conserva su comisión de origen</span>
    </div>

    ${
      isCrossSellOpen
        ? `<div class="cross-sell-drawer">
            <form class="stack-form compact-form" data-form="cross-sell" data-dossier-id="${escapeHtml(
              dossier.id
            )}" novalidate>
              <div class="form-row-2">
                <div class="form-field">
                  <label for="cs-branch-${escapeHtml(dossier.id)}" class="field-label">Nuevo ramo a cotizar para ${escapeHtml(
                    dossier.fullName
                  )}</label>
                  <select id="cs-branch-${escapeHtml(dossier.id)}" name="branchCode" class="select-control">
                    ${crossSellOptionsHtml}
                  </select>
                </div>
                <div class="form-field">
                  <label for="cs-notes-${escapeHtml(dossier.id)}" class="field-label">Nota comercial de detección</label>
                  <input
                    type="text"
                    id="cs-notes-${escapeHtml(dossier.id)}"
                    name="notes"
                    class="input-control"
                    autocomplete="off"
                    placeholder="Ej. Solicitó proteger segundo auto o gastos médicos…"
                  />
                </div>
              </div>

              <div class="form-row-action">
                <label class="checkbox-card" for="cs-dup-${escapeHtml(dossier.id)}" style="flex: 1 1 260px;">
                  <input type="checkbox" id="cs-dup-${escapeHtml(dossier.id)}" name="allowDuplicateBranch" />
                  <span>Permitir segunda póliza paralela del mismo ramo (ej. segundo vehículo familiar)</span>
                </label>
                <button type="submit" class="btn btn-accent">Abrir oportunidad vinculada</button>
              </div>
              <div class="inline-error" data-role="cs-error" role="alert" hidden></div>
            </form>
          </div>`
        : ''
    }

    <div class="opportunity-list">
      ${opportunitiesHtml}
    </div>
  </article>`;
}

function renderVendorOpportunityRowHtml(dossier, opp) {
  const branchMeta = findBranchByCode(opp.branchCode);
  const stageMeta = STAGE_BY_CODE[opp.stage];
  const badgeMeta = getCommissionBadgeMeta(opp.commission?.commissionStatus);
  const isTerminal = Boolean(stageMeta?.isTerminal);
  const suggestedStage = getSuggestedNextStage(opp.stage);

  const stageSelectOptions = COMMERCIAL_STAGES.map(
    (st) =>
      `<option value="${escapeHtml(st.code)}" ${
        st.code === suggestedStage ? 'selected' : ''
      }>${st.stepNumber}. ${escapeHtml(st.label)}</option>`
  ).join('');

  const showEstimated = suggestedStage === STAGE_CODES.EN_COTIZACION;
  const showFinal = suggestedStage === STAGE_CODES.POLIZA_PAGADA;
  const showRejection = suggestedStage === STAGE_CODES.DESCARTADO;

  const auditItemsHtml = (opp.auditTrail || [])
    .map(
      (entry) =>
        `<li>
          <span class="tabular">${escapeHtml(formatDateTime(entry.timestamp))}</span> —
          <strong>${escapeHtml(STAGE_BY_CODE[entry.toStage]?.label || entry.toStage)}</strong>
          (${escapeHtml(entry.actorRole)}): ${escapeHtml(entry.notes)}
        </li>`
    )
    .join('');

  return `<div class="opportunity-row" data-opp-id="${escapeHtml(opp.id)}">
    <div class="opportunity-top">
      <div class="opportunity-branch-group">
        <span class="opportunity-branch-title">${escapeHtml(
          branchMeta ? branchMeta.name : opp.branchCode
        )}</span>
        <span class="pill pill-neutral tabular">ID: ${escapeHtml(opp.id)}</span>
        ${
          opp.isCrossSell
            ? `<span class="pill pill-blue">Venta Cruzada</span>`
            : ''
        }
      </div>

      <div class="opportunity-commission-box tabular">
        <span class="pill ${badgeMeta.pillClass}">${escapeHtml(badgeMeta.label)}</span>
        <span>Comisión referidor (${escapeHtml(formatPercent(opp.commission?.ratePercent || 0))}): <strong>${escapeHtml(
          formatMxn(opp.commission?.commissionAmount || 0)
        )}</strong></span>
      </div>
    </div>

    ${renderStageStepperHtml(opp.stage)}

    ${
      isTerminal
        ? `<div class="transition-panel">
            <div class="section-caption tabular">
              <strong>Etapa terminal bloqueada para Vendedor:</strong> ${escapeHtml(
                stageMeta?.label || opp.stage
              )}.
              ${
                opp.stage === STAGE_CODES.POLIZA_PAGADA
                  ? `Prima anual liquidada: <strong>${escapeHtml(
                      formatMxn(opp.finalPremium || opp.estimatedPremium)
                    )}</strong> · Comisión habilitada para cobro: <strong>${escapeHtml(
                      formatMxn(opp.commission?.commissionAmount)
                    )}</strong>.`
                  : `Motivo registrado: <strong>${escapeHtml(opp.rejectionReason || 'No especificado')}</strong>.`
              }
            </div>
          </div>`
        : `<form
            class="transition-panel"
            data-form="transition-stage"
            data-dossier-id="${escapeHtml(dossier.id)}"
            data-opp-id="${escapeHtml(opp.id)}"
            novalidate
          >
            <div class="transition-grid">
              <div class="form-field">
                <label for="next-stage-${escapeHtml(opp.id)}" class="field-label">Avanzar / actualizar etapa</label>
                <select
                  id="next-stage-${escapeHtml(opp.id)}"
                  name="nextStage"
                  class="select-control"
                  data-action="change-target-stage"
                >
                  ${stageSelectOptions}
                </select>
              </div>

              <div class="form-field" data-cond="estimated" ${showEstimated ? '' : 'hidden'}>
                <label for="est-prem-${escapeHtml(opp.id)}" class="field-label">Prima anual estimada (MXN)</label>
                <input
                  type="number"
                  id="est-prem-${escapeHtml(opp.id)}"
                  name="estimatedPremium"
                  class="input-control tabular"
                  min="1"
                  step="100"
                  value="${opp.estimatedPremium > 0 ? escapeHtml(opp.estimatedPremium) : ''}"
                  placeholder="Ej. 18500…"
                />
              </div>

              <div class="form-field" data-cond="final" ${showFinal ? '' : 'hidden'}>
                <label for="fin-prem-${escapeHtml(opp.id)}" class="field-label">Prima anual pagada (MXN)</label>
                <input
                  type="number"
                  id="fin-prem-${escapeHtml(opp.id)}"
                  name="finalPremium"
                  class="input-control tabular"
                  min="1"
                  step="100"
                  value="${
                    opp.finalPremium > 0
                      ? escapeHtml(opp.finalPremium)
                      : opp.estimatedPremium > 0
                        ? escapeHtml(opp.estimatedPremium)
                        : ''
                  }"
                  placeholder="Ej. 18200…"
                />
              </div>

              <div class="form-field" data-cond="rejection" ${showRejection ? '' : 'hidden'}>
                <label for="rej-reason-${escapeHtml(opp.id)}" class="field-label">Motivo de descarte (mín. 5 caracteres)</label>
                <input
                  type="text"
                  id="rej-reason-${escapeHtml(opp.id)}"
                  name="rejectionReason"
                  class="input-control"
                  autocomplete="off"
                  placeholder="Ej. Póliza multianual vigente con banco…"
                />
              </div>

              <div class="form-field">
                <label for="notes-${escapeHtml(opp.id)}" class="field-label">Nota de bitácora (opcional)</label>
                <input
                  type="text"
                  id="notes-${escapeHtml(opp.id)}"
                  name="notes"
                  class="input-control"
                  autocomplete="off"
                  placeholder="Ej. Envío comparativo de coberturas…"
                />
              </div>
            </div>

            <div class="form-row-action" style="justify-content: space-between; align-items: center;">
              <span class="field-hint tabular" data-role="live-preview">
                ${escapeHtml(computeLiveTransitionHint(opp, suggestedStage, opp.estimatedPremium, opp.finalPremium))}
              </span>
              <button type="submit" class="btn btn-primary btn-sm">Guardar etapa y notificar WhatsApp</button>
            </div>

            <div class="inline-error" data-role="transition-error" role="alert" hidden></div>
          </form>`
    }

    <details class="audit-details">
      <summary>Bitácora de auditoría (${(opp.auditTrail || []).length} movimiento${
        (opp.auditTrail || []).length === 1 ? '' : 's'
      })</summary>
      <ol class="audit-list">
        ${auditItemsHtml}
      </ol>
    </details>
  </div>`;
}

/**
 * Emplea `transitionOpportunityStage` en seco (in-memory sin mutar estado) para anticipar al
 * vendedor cómo impactará su captura sobre la comisión del prospectador antes de guardar.
 */
function computeLiveTransitionHint(opp, nextStage, rawEstimated, rawFinal) {
  try {
    const candidateEst =
      rawEstimated !== '' && rawEstimated !== undefined && rawEstimated !== null
        ? Number(rawEstimated)
        : opp.estimatedPremium;
    const candidateFin =
      rawFinal !== '' && rawFinal !== undefined && rawFinal !== null
        ? Number(rawFinal)
        : opp.finalPremium;

    const simulated = transitionOpportunityStage(opp, {
      nextStage,
      actorId: state.activeAgentId,
      actorRole: ROLES.VENDEDOR,
      estimatedPremium: candidateEst,
      finalPremium: candidateFin,
      rejectionReason: nextStage === STAGE_CODES.DESCARTADO ? 'Simulación preventiva' : undefined,
      customRules: state.customRules,
      branches: state.branches,
    });

    const badge = getCommissionBadgeMeta(simulated.commission.commissionStatus);
    return `Vista previa comisión referidor: ${formatMxn(
      simulated.commission.commissionAmount
    )} (${formatPercent(simulated.commission.ratePercent)} · ${badge.label})`;
  } catch {
    if (nextStage === STAGE_CODES.EN_COTIZACION) {
      return 'Capture una prima estimada > $0 para calcular la comisión proyectada.';
    }
    if (nextStage === STAGE_CODES.POLIZA_PAGADA) {
      return 'Capture la prima emitida/pagada > $0 para liberar el cobro de comisión.';
    }
    if (nextStage === STAGE_CODES.DESCARTADO) {
      return 'Especifique un motivo claro (>= 5 caracteres) para informar al prospectador.';
    }
    return 'Listo para registrar avance en bitácora y despachar alerta.';
  }
}

function renderOutboxInspector() {
  const countBadge = document.getElementById('outbox-count-badge');
  const selectEvent = document.getElementById('select-outbox-event');
  const liveContainer = document.getElementById('outbox-live-content');
  if (!countBadge || !selectEvent || !liveContainer) return;

  countBadge.textContent = `${state.outboxEvents.length} evento${
    state.outboxEvents.length === 1 ? '' : 's'
  }`;

  if (state.outboxEvents.length === 0) {
    selectEvent.innerHTML = `<option value="">Sin eventos despachados</option>`;
    liveContainer.innerHTML = `<div class="empty-state">Avance cualquier etapa comercial para inspeccionar el despacho WhatsApp + Push.</div>`;
    return;
  }

  if (!state.outboxEvents.some((ev) => ev.id === state.selectedOutboxEventId)) {
    state.selectedOutboxEventId = state.outboxEvents[0].id;
  }

  selectEvent.innerHTML = state.outboxEvents
    .map(
      (ev, idx) =>
        `<option value="${escapeHtml(ev.id)}" ${
          ev.id === state.selectedOutboxEventId ? 'selected' : ''
        }>${idx === 0 ? '[Último] ' : ''}${escapeHtml(ev.prospectName)} → ${escapeHtml(
          ev.stageLabel
        )} (${escapeHtml(ev.branchName)})</option>`
    )
    .join('');

  const activeEvent =
    state.outboxEvents.find((ev) => ev.id === state.selectedOutboxEventId) || state.outboxEvents[0];
  const { payload } = activeEvent;
  const jsonToDisplay =
    state.outboxJsonMode === 'push' ? payload.pushPayload : payload.whatsappPayload;

  liveContainer.innerHTML = `
    <div class="push-preview-box">
      <div class="push-header tabular">
        <span>Notificación Push Móvil (FCM / APNs)</span>
        <span>${escapeHtml(formatDateTime(activeEvent.createdAt))}</span>
      </div>
      <p class="push-title">${escapeHtml(payload.pushPayload.notification.title)}</p>
      <p class="push-body">${escapeHtml(payload.pushPayload.notification.body)}</p>
      <div class="rates-pills-wrap tabular">
        <span class="pill pill-neutral"><code translate="no">${escapeHtml(
          payload.pushPayload.data.stage
        )}</code></span>
        <span class="pill pill-blue">${escapeHtml(
          payload.pushPayload.data.commissionStatus
        )}</span>
        <span class="pill pill-emerald">$${escapeHtml(
          payload.pushPayload.data.commissionAmount
        )} MXN</span>
      </div>
    </div>

    <div class="wa-preview-box">
      <div class="wa-header tabular">
        <span>WhatsApp recibido por ${escapeHtml(activeEvent.referrerName)}</span>
        <span>${escapeHtml(payload.recipientPhone)}</span>
      </div>
      <div class="wa-bubble">
        ${escapeHtml(payload.previewText)}
      </div>
    </div>

    <div>
      <div class="json-toolbar">
        <div class="inline-buttons">
          <button
            type="button"
            class="btn btn-sm ${state.outboxJsonMode === 'whatsapp' ? 'btn-primary' : 'btn-ghost'}"
            data-action="switch-outbox-json"
            data-mode="whatsapp"
          >
            Payload Meta WhatsApp
          </button>
          <button
            type="button"
            class="btn btn-sm ${state.outboxJsonMode === 'push' ? 'btn-primary' : 'btn-ghost'}"
            data-action="switch-outbox-json"
            data-mode="push"
          >
            Payload Push FCM
          </button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-action="copy-outbox-json">
          Copiar JSON
        </button>
      </div>
      <pre class="json-terminal"><code translate="no">${escapeHtml(
        JSON.stringify(jsonToDisplay, null, 2)
      )}</code></pre>
    </div>
  `;
}

/* ============================================================================
   RENDERIZADO PESTAÑA 3: PANEL ADMINISTRATIVO WEB
   ============================================================================ */
function renderAdminView() {
  const errorEl = document.getElementById('admin-filter-error');
  const filterCaption = document.getElementById('admin-active-filter-caption');
  const printSummary = document.getElementById('print-meta-summary');

  let kpis;
  try {
    kpis = computeDashboardKpis({
      dossiers: state.dossiers,
      users: state.users,
      branches: state.branches,
      filters: state.adminFilters,
    });
    if (errorEl) errorEl.hidden = true;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.hidden = false;
    }
    return;
  }

  // Descripción legible de filtros activos para pantalla e impresión PDF
  const activeFilterParts = [];
  if (state.adminFilters.agentId) {
    const agt = findUserById(state.adminFilters.agentId);
    activeFilterParts.push(`Vendedor: ${agt ? agt.fullName : state.adminFilters.agentId}`);
  }
  if (state.adminFilters.referrerId) {
    const ref = findUserById(state.adminFilters.referrerId);
    activeFilterParts.push(`Prospectador: ${ref ? ref.fullName : state.adminFilters.referrerId}`);
  }
  if (state.adminFilters.startDate) {
    activeFilterParts.push(`Desde: ${state.adminFilters.startDate}`);
  }
  if (state.adminFilters.endDate) {
    activeFilterParts.push(`Hasta: ${state.adminFilters.endDate}`);
  }
  const filterSummaryText =
    activeFilterParts.length > 0
      ? `Filtro aplicado — ${activeFilterParts.join(' · ')}`
      : 'Universo completo sin filtros restrictivos';

  if (filterCaption) filterCaption.textContent = filterSummaryText;
  if (printSummary) {
    printSummary.textContent = `${filterSummaryText} · Emitido: ${formatDateTime(
      new Date().toISOString()
    )}`;
  }

  const totalConfirmedComm = kpis.referrerRanking.reduce(
    (sum, row) => roundCurrency(sum + row.confirmedCommissionAmount),
    0
  );
  const totalPipelineComm = kpis.referrerRanking.reduce(
    (sum, row) => roundCurrency(sum + row.pipelineCommissionAmount),
    0
  );
  const totalReferrersRegistered = getUsersByRole(ROLES.PROSPECTADOR).length;
  const totalAgentsRegistered = getUsersByRole(ROLES.VENDEDOR).length;

  // 4 Tarjetas Ejecutivas KPI
  const kpiCardsEl = document.getElementById('admin-kpi-cards');
  if (kpiCardsEl) {
    kpiCardsEl.innerHTML = `
      <article class="kpi-card accent-primary">
        <span class="kpi-label">Fuerza operativa con flujo activo</span>
        <strong class="kpi-value">${kpis.activeForce.activeReferrers} prospectadores · ${kpis.activeForce.activeAgents} agentes</strong>
        <span class="kpi-foot tabular">Padrón registrado: ${totalReferrersRegistered} referidores y ${totalAgentsRegistered} vendedores</span>
      </article>

      <article class="kpi-card accent-blue">
        <span class="kpi-label">Volumen de prospección y multi-ramo</span>
        <strong class="kpi-value">${kpis.prospectionVolume.totalOpportunities} oportunidades</strong>
        <span class="kpi-foot tabular">${kpis.prospectionVolume.totalDossiers} expedientes únicos · ${kpis.prospectionVolume.crossSellOpportunities} ventas cruzadas</span>
      </article>

      <article class="kpi-card accent-emerald">
        <span class="kpi-label">Tasa de cierre global</span>
        <strong class="kpi-value is-emerald">${escapeHtml(
          formatPercent(kpis.funnel.conversionRatePercent)
        )}</strong>
        <span class="kpi-foot tabular">${kpis.funnel.closedWonCount} pólizas pagadas · ${kpis.funnel.discardedCount} descartadas</span>
      </article>

      <article class="kpi-card accent-amber">
        <span class="kpi-label">Comisiones confirmadas para dispersión</span>
        <strong class="kpi-value is-emerald">${escapeHtml(formatMxn(totalConfirmedComm))}</strong>
        <span class="kpi-foot tabular">En cotización / suscripción: ${escapeHtml(
          formatMxn(totalPipelineComm)
        )}</span>
      </article>
    `;
  }

  // Desglose de Estancamiento (5 fases no terminales)
  const stag = kpis.funnel.stagnation;
  const totalStagnant =
    stag.uncontactedCount +
    stag.inCallCount +
    stag.inAppointmentCount +
    stag.inQuotationCount +
    stag.inApplicationCount;

  const stagPill = document.getElementById('stagnation-total-pill');
  if (stagPill) {
    stagPill.textContent = `${totalStagnant} oportunidad(es) activas en seguimiento`;
  }

  const stagnationItems = [
    {
      label: 'Sin contactar (Nuevo)',
      count: stag.uncontactedCount,
      hint: 'Pendientes de primera llamada',
      tone: '',
    },
    {
      label: 'Detenidos en llamada',
      count: stag.inCallCount,
      hint: '1er contacto sin cita agendada',
      tone: 'is-blue',
    },
    {
      label: 'Detenidos en cita',
      count: stag.inAppointmentCount,
      hint: 'Diagnóstico pendiente de cotizar',
      tone: 'is-blue',
    },
    {
      label: 'Detenidos en cotización',
      count: stag.inQuotationCount,
      hint: 'Propuesta enviada sin solicitud',
      tone: '',
    },
    {
      label: 'En solicitud / suscripción',
      count: stag.inApplicationCount,
      hint: 'Pendientes de emisión o pago',
      tone: '',
    },
  ];

  const stagGrid = document.getElementById('admin-stagnation-grid');
  if (stagGrid) {
    stagGrid.innerHTML = stagnationItems
      .map((item) => {
        const ratio = totalStagnant > 0 ? Math.max(0.04, item.count / totalStagnant) : 0;
        const sharePct =
          totalStagnant > 0 ? roundCurrency((item.count / totalStagnant) * 100) : 0;
        return `<div class="stagnation-item">
          <div class="stagnation-top">
            <span class="stagnation-label">${escapeHtml(item.label)}</span>
            <strong class="stagnation-count tabular">${item.count}</strong>
          </div>
          <div class="meter-track" aria-hidden="true">
            <div class="meter-fill ${item.tone}" style="transform: scaleX(${
              item.count === 0 ? 0 : ratio.toFixed(3)
            });"></div>
          </div>
          <span class="section-caption tabular">${escapeHtml(formatPercent(sharePct))} del embudo abierto · ${escapeHtml(
            item.hint
          )}</span>
        </div>`;
      })
      .join('');
  }

  // Tabla 1: Desempeño por Ramo
  const tbodyBranch = document.getElementById('tbody-branch-performance');
  if (tbodyBranch) {
    tbodyBranch.innerHTML = kpis.branchPerformance
      .map((row) => {
        const branchMeta = findBranchByCode(row.branchCode);
        const baseRate = branchMeta ? branchMeta.defaultCommissionRate : 0;
        return `<tr>
          <td>
            <strong>${escapeHtml(row.branchName)}</strong>
            <div class="section-caption"><code translate="no">${escapeHtml(row.branchCode)}</code></div>
          </td>
          <td class="num-col">${escapeHtml(formatPercent(baseRate))}</td>
          <td class="num-col">${row.totalOpportunities}</td>
          <td class="num-col">${row.closedWonCount}</td>
          <td class="num-col">${escapeHtml(formatPercent(row.conversionRatePercent))}</td>
          <td class="num-col"><strong>${escapeHtml(formatMxn(row.totalClosedPremium))}</strong></td>
        </tr>`;
      })
      .join('');
  }

  // Tabla 2: Ranking de Prospectadores
  const tbodyRanking = document.getElementById('tbody-referrer-ranking');
  if (tbodyRanking) {
    if (kpis.referrerRanking.length === 0) {
      tbodyRanking.innerHTML = `<tr><td colspan="6" class="section-caption">Sin registros para el filtro actual.</td></tr>`;
    } else {
      tbodyRanking.innerHTML = kpis.referrerRanking
        .map(
          (row, idx) => `<tr>
            <td>
              <strong>#${idx + 1} ${escapeHtml(row.referrerName)}</strong>
            </td>
            <td class="num-col">${row.totalDossiers} (${row.totalOpportunities} ramos)</td>
            <td class="num-col">${row.closedWonCount}</td>
            <td class="num-col">${escapeHtml(formatPercent(row.conversionRatePercent))}</td>
            <td class="num-col"><span class="pill pill-emerald">${escapeHtml(
              formatMxn(row.confirmedCommissionAmount)
            )}</span></td>
            <td class="num-col"><span class="pill pill-amber">${escapeHtml(
              formatMxn(row.pipelineCommissionAmount)
            )}</span></td>
          </tr>`
        )
        .join('');
    }
  }

  // Tabla de convenios personalizados de comisión
  const tbodyRules = document.getElementById('tbody-custom-rules');
  if (tbodyRules) {
    const activeRules = state.customRules.filter((r) => r.active !== false);
    if (activeRules.length === 0) {
      tbodyRules.innerHTML = `<tr><td colspan="6" class="section-caption">Todos los prospectadores operan actualmente con la comisión base del catálogo.</td></tr>`;
    } else {
      tbodyRules.innerHTML = activeRules
        .map((rule) => {
          const refUser = findUserById(rule.referrerId);
          const branch = findBranchByCode(rule.branchCode);
          return `<tr>
            <td><strong>${escapeHtml(refUser ? refUser.fullName : rule.referrerId)}</strong></td>
            <td>${escapeHtml(branch ? branch.name : rule.branchCode)}</td>
            <td class="num-col">${escapeHtml(
              formatPercent(branch ? branch.defaultCommissionRate : 0)
            )}</td>
            <td class="num-col"><strong>${escapeHtml(formatPercent(rule.ratePercent))}</strong></td>
            <td>${escapeHtml(rule.note || 'Convenio directo')}</td>
            <td class="num-col">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                data-action="delete-rule"
                data-rule-id="${escapeHtml(rule.id)}"
              >
                Restablecer
              </button>
            </td>
          </tr>`;
        })
        .join('');
    }
  }

  // Píldoras del catálogo activo de productos
  const catalogEl = document.getElementById('admin-branches-catalog');
  if (catalogEl) {
    catalogEl.innerHTML = state.branches
      .map(
        (branch) => `<span class="rate-chip tabular">
          <span>${escapeHtml(branch.name)} (<code translate="no">${escapeHtml(branch.code)}</code>)</span>
          <strong>${escapeHtml(formatPercent(branch.defaultCommissionRate))}</strong>
        </span>`
      )
      .join('');
  }
}

function renderAll() {
  syncStaticControls();
  renderProspectadorView();
  renderVendedorView();
  renderAdminView();
}

/* ============================================================================
   EXPORTACIÓN CSV UTF-8 CON BOM Y REPORTE PDF IMPRIMIBLE
   ============================================================================ */
function exportAdminReportCsv() {
  const kpis = computeDashboardKpis({
    dossiers: state.dossiers,
    users: state.users,
    branches: state.branches,
    filters: state.adminFilters,
  });

  const rows = [];
  rows.push(['REPORTE EJECUTIVO INGRESOCERTEZA']);
  rows.push(['Fecha generación', new Date().toISOString()]);
  rows.push([
    'Prospectadores activos',
    kpis.activeForce.activeReferrers,
    'Agentes activos',
    kpis.activeForce.activeAgents,
  ]);
  rows.push([
    'Expedientes únicos',
    kpis.prospectionVolume.totalDossiers,
    'Oportunidades totales',
    kpis.prospectionVolume.totalOpportunities,
    'Ventas cruzadas',
    kpis.prospectionVolume.crossSellOpportunities,
  ]);
  rows.push([
    'Tasa cierre global (%)',
    kpis.funnel.conversionRatePercent,
    'Pólizas pagadas',
    kpis.funnel.closedWonCount,
    'Descartadas',
    kpis.funnel.discardedCount,
  ]);
  rows.push([]);

  rows.push(['DESGLOSE DE ESTANCAMIENTO COMERCIAL']);
  rows.push(['Fase activa', 'Oportunidades detenidas']);
  rows.push(['Sin contactar (Nuevo)', kpis.funnel.stagnation.uncontactedCount]);
  rows.push(['Detenidos en llamada', kpis.funnel.stagnation.inCallCount]);
  rows.push(['Detenidos en cita', kpis.funnel.stagnation.inAppointmentCount]);
  rows.push(['Detenidos en cotización', kpis.funnel.stagnation.inQuotationCount]);
  rows.push(['En solicitud / suscripción', kpis.funnel.stagnation.inApplicationCount]);
  rows.push([]);

  rows.push(['DESEMPEÑO POR RAMO ASEGURADOR']);
  rows.push([
    'Código Ramo',
    'Nombre Ramo',
    'Oportunidades',
    'Pólizas Pagadas',
    'Conversión (%)',
    'Prima Cerrada (MXN)',
  ]);
  kpis.branchPerformance.forEach((b) => {
    rows.push([
      b.branchCode,
      b.branchName,
      b.totalOpportunities,
      b.closedWonCount,
      b.conversionRatePercent,
      b.totalClosedPremium,
    ]);
  });
  rows.push([]);

  rows.push(['RANKING DE PROSPECTADORES']);
  rows.push([
    'Prospectador',
    'Expedientes',
    'Oportunidades',
    'Pólizas Pagadas',
    'Conversión (%)',
    'Comisión Lista para Cobro (MXN)',
    'Comisión en Cotización (MXN)',
  ]);
  kpis.referrerRanking.forEach((r) => {
    rows.push([
      r.referrerName,
      r.totalDossiers,
      r.totalOpportunities,
      r.closedWonCount,
      r.conversionRatePercent,
      r.confirmedCommissionAmount,
      r.pipelineCommissionAmount,
    ]);
  });
  rows.push([]);

  rows.push(['DETALLE DE OPORTUNIDADES Y TRAZABILIDAD DE COMISIONES']);
  rows.push([
    'ID Expediente',
    'ID Oportunidad',
    'Prospecto',
    'WhatsApp E.164',
    'Prospectador Origen',
    'Vendedor Asignado',
    'Ramo',
    'Venta Cruzada',
    'Etapa Actual',
    'Prima Estimada (MXN)',
    'Prima Pagada (MXN)',
    'Tasa Comisión (%)',
    'Monto Comisión (MXN)',
    'Estatus Comisión',
  ]);

  state.dossiers.forEach((dossier) => {
    dossier.opportunities.forEach((opp) => {
      const refUser = findUserById(opp.originalReferrerId || dossier.originalReferrerId);
      const agtUser = findUserById(opp.assignedAgentId || dossier.assignedAgentId);
      const branch = findBranchByCode(opp.branchCode);
      const stageMeta = STAGE_BY_CODE[opp.stage];
      rows.push([
        dossier.id,
        opp.id,
        dossier.fullName,
        dossier.phone,
        refUser ? refUser.fullName : dossier.originalReferrerId,
        agtUser ? agtUser.fullName : dossier.assignedAgentId || '',
        branch ? branch.name : opp.branchCode,
        opp.isCrossSell ? 'Sí' : 'No',
        stageMeta ? stageMeta.label : opp.stage,
        opp.estimatedPremium,
        opp.finalPremium,
        opp.commission?.ratePercent ?? 0,
        opp.commission?.commissionAmount ?? 0,
        opp.commission?.commissionStatus ?? '',
      ]);
    });
  });

  const csvBody = rows.map((line) => line.map(sanitizeCsvCell).join(',')).join('\r\n');
  // Prefijo BOM UTF-8 (\uFEFF) para que Microsoft Excel en Windows interprete tildes y eñes correctamente
  const blob = new Blob([`\uFEFF${csvBody}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const dateStamp = new Date().toISOString().slice(0, 10);

  const link = document.createElement('a');
  link.href = url;
  link.download = `ingreso-certeza-reporte-${dateStamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast('Archivo CSV (UTF-8 con BOM para Excel) descargado correctamente.');
}

/* ============================================================================
   REGISTRO DE EVENTOS DE INTERFAZ
   ============================================================================ */
function bindEvents() {
  // Navegación por clic y teclado en pestañas principales
  const tabList = document.querySelector('[role="tablist"]');
  if (tabList) {
    tabList.addEventListener('click', (event) => {
      const trigger = event.target.closest('[role="tab"][data-tab]');
      if (!trigger) return;
      setActiveTab(trigger.dataset.tab, false);
    });

    tabList.addEventListener('keydown', (event) => {
      const triggers = Array.from(tabList.querySelectorAll('[role="tab"][data-tab]'));
      const currentIndex = triggers.indexOf(document.activeElement);
      if (currentIndex === -1) return;

      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % triggers.length;
      if (event.key === 'ArrowLeft')
        nextIndex = (currentIndex - 1 + triggers.length) % triggers.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = triggers.length - 1;

      if (nextIndex !== null) {
        event.preventDefault();
        setActiveTab(triggers[nextIndex].dataset.tab, true);
      }
    });
  }

  // Botón global Restablecer datos demo
  document.getElementById('btn-reset-demo')?.addEventListener('click', () => {
    initializeDemoState();
    const digestPanel = document.getElementById('weekly-digest-panel');
    if (digestPanel) digestPanel.hidden = true;
    renderAll();
    showToast('Datos demostrativos restaurados al estado inicial del dominio.');
  });

  // Cambio de prospectador activo (RBAC)
  document.getElementById('select-referrer')?.addEventListener('change', (event) => {
    state.activeReferrerId = event.target.value;
    renderProspectadorView();
  });

  // Validación telefónica E.164 en tiempo real mientras captura el prospectador
  const updatePhoneHint = () => {
    const phoneInput = document.getElementById('input-prospect-phone');
    const ccSelect = document.getElementById('select-prospect-cc');
    const hintEl = document.getElementById('phone-e164-hint');
    if (!phoneInput || !ccSelect || !hintEl) return;

    const raw = phoneInput.value.trim();
    if (!raw) {
      hintEl.textContent = 'Formato destino Meta Cloud API: pendiente de captura.';
      hintEl.className = 'field-hint';
      return;
    }

    try {
      const normalized = normalizeWhatsAppPhone(raw, ccSelect.value);
      hintEl.textContent = `Número E.164 verificado para WhatsApp: ${normalized}`;
      hintEl.className = 'field-hint is-valid tabular';
    } catch (err) {
      hintEl.textContent = err instanceof Error ? err.message : String(err);
      hintEl.className = 'field-hint is-invalid';
    }
  };

  document.getElementById('input-prospect-phone')?.addEventListener('input', updatePhoneHint);
  document.getElementById('select-prospect-cc')?.addEventListener('change', updatePhoneHint);

  // Simular Resumen Semanal WhatsApp (Pestaña 1)
  document.getElementById('btn-weekly-digest')?.addEventListener('click', () => {
    renderWeeklyDigestSimulation();
    document.getElementById('weekly-digest-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  document.getElementById('btn-close-digest')?.addEventListener('click', () => {
    const panel = document.getElementById('weekly-digest-panel');
    if (panel) panel.hidden = true;
  });

  document.getElementById('btn-copy-digest-json')?.addEventListener('click', async () => {
    if (!state.lastWeeklyDigest) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(state.lastWeeklyDigest.whatsappPayload, null, 2)
      );
      showToast('Payload JSON del resumen semanal copiado al portapapeles.');
    } catch {
      showToast('No fue posible acceder al portapapeles en este navegador.', true);
    }
  });

  // Alta de nuevo prospecto referido (Pestaña 1)
  document.getElementById('form-new-prospect')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const errorBox = document.getElementById('prospect-form-error');
    if (errorBox) errorBox.hidden = true;

    const nameInput = document.getElementById('input-prospect-name');
    const phoneInput = document.getElementById('input-prospect-phone');
    const ccSelect = document.getElementById('select-prospect-cc');
    const emailInput = document.getElementById('input-prospect-email');
    const agentSelect = document.getElementById('select-prospect-agent');
    const notesInput = document.getElementById('input-prospect-notes');
    const privacyInput = document.getElementById('input-prospect-privacy');

    const selectedBranches = Array.from(
      form.querySelectorAll('input[name="initialBranches"]:checked')
    ).map((chk) => chk.value);

    if (!privacyInput?.checked) {
      if (errorBox) {
        errorBox.textContent =
          'Es obligatorio confirmar la aceptación del Aviso de Privacidad Integral (LFPDPPP) antes de registrar al prospecto.';
        errorBox.hidden = false;
      }
      privacyInput?.focus();
      return;
    }

    try {
      const nextId = `dos-${String(state.dossierSeq).padStart(3, '0')}`;
      const newDossier = createProspectDossier({
        id: nextId,
        fullName: nameInput?.value || '',
        phone: phoneInput?.value || '',
        email: emailInput?.value || null,
        initialBranchCodes: selectedBranches,
        referrerId: state.activeReferrerId,
        assignedAgentId: agentSelect?.value || null,
        notes: notesInput?.value || '',
        privacyNoticeAccepted: true,
        defaultCountryCode: ccSelect?.value || '52',
        customRules: state.customRules,
        branches: state.branches,
      });

      state.dossierSeq += 1;
      state.dossiers = [newDossier, ...state.dossiers];
      newDossier.opportunities.forEach((opp) => {
        pushOutboxAlert({ dossier: newDossier, opportunity: opp });
      });

      form.reset();
      updatePhoneHint();
      renderAll();
      showToast(
        `Expediente ${newDossier.id} creado con ${newDossier.opportunities.length} ramo(s) y alerta WhatsApp encolada.`
      );
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err instanceof Error ? err.message : String(err);
        errorBox.hidden = false;
      }
      if (!nameInput?.value.trim()) {
        nameInput?.focus();
      } else if (!phoneInput?.value.trim()) {
        phoneInput?.focus();
      }
    }
  });

  // Controles de cabecera Pestaña 2 (Vendedor)
  document.getElementById('select-agent')?.addEventListener('change', (event) => {
    state.activeAgentId = event.target.value;
    renderVendedorView();
  });

  document.getElementById('select-agent-stage-filter')?.addEventListener('change', (event) => {
    state.agentStageFilter = event.target.value;
    renderVendedorView();
  });

  // Delegación de eventos en lista de expedientes del Vendedor
  const agentListEl = document.getElementById('agent-dossiers-list');
  if (agentListEl) {
    agentListEl.addEventListener('click', (event) => {
      const toggleBtn = event.target.closest('[data-action="toggle-cross-sell"]');
      if (!toggleBtn) return;
      const dossierId = toggleBtn.dataset.dossierId;
      if (!dossierId) return;

      if (state.openCrossSellDossierIds.has(dossierId)) {
        state.openCrossSellDossierIds.delete(dossierId);
      } else {
        state.openCrossSellDossierIds.add(dossierId);
      }
      renderVendedorView();
    });

    // Mostrar/ocultar campos condicionales y recalcular vista previa de comisión
    const handleTransitionFieldUpdate = (event) => {
      const form = event.target.closest('form[data-form="transition-stage"]');
      if (!form) return;

      const stageSelect = form.querySelector('select[name="nextStage"]');
      const estWrap = form.querySelector('[data-cond="estimated"]');
      const finWrap = form.querySelector('[data-cond="final"]');
      const rejWrap = form.querySelector('[data-cond="rejection"]');
      const previewEl = form.querySelector('[data-role="live-preview"]');
      const errorBox = form.querySelector('[data-role="transition-error"]');

      if (errorBox && event.target === stageSelect) {
        errorBox.hidden = true;
      }

      const nextStage = stageSelect?.value || '';
      if (estWrap) estWrap.hidden = nextStage !== STAGE_CODES.EN_COTIZACION;
      if (finWrap) finWrap.hidden = nextStage !== STAGE_CODES.POLIZA_PAGADA;
      if (rejWrap) rejWrap.hidden = nextStage !== STAGE_CODES.DESCARTADO;

      const dossier = state.dossiers.find((d) => d.id === form.dataset.dossierId);
      const opp = dossier?.opportunities.find((o) => o.id === form.dataset.oppId);
      if (opp && previewEl) {
        const estVal = form.querySelector('input[name="estimatedPremium"]')?.value;
        const finVal = form.querySelector('input[name="finalPremium"]')?.value;
        previewEl.textContent = computeLiveTransitionHint(opp, nextStage, estVal, finVal);
      }
    };

    agentListEl.addEventListener('change', handleTransitionFieldUpdate);
    agentListEl.addEventListener('input', handleTransitionFieldUpdate);

    // Submit de transición de etapa o de venta cruzada
    agentListEl.addEventListener('submit', (event) => {
      const transitionForm = event.target.closest('form[data-form="transition-stage"]');
      if (transitionForm) {
        event.preventDefault();
        handleStageTransitionSubmit(transitionForm);
        return;
      }

      const crossSellForm = event.target.closest('form[data-form="cross-sell"]');
      if (crossSellForm) {
        event.preventDefault();
        handleCrossSellSubmit(crossSellForm);
      }
    });
  }

  // Controles del Inspector Transactional Outbox
  document.getElementById('select-outbox-event')?.addEventListener('change', (event) => {
    state.selectedOutboxEventId = event.target.value;
    renderOutboxInspector();
  });

  document.getElementById('outbox-live-content')?.addEventListener('click', async (event) => {
    const modeBtn = event.target.closest('[data-action="switch-outbox-json"]');
    if (modeBtn) {
      state.outboxJsonMode = modeBtn.dataset.mode === 'push' ? 'push' : 'whatsapp';
      renderOutboxInspector();
      return;
    }

    const copyBtn = event.target.closest('[data-action="copy-outbox-json"]');
    if (copyBtn) {
      const activeEvent =
        state.outboxEvents.find((ev) => ev.id === state.selectedOutboxEventId) ||
        state.outboxEvents[0];
      if (!activeEvent) return;
      const targetPayload =
        state.outboxJsonMode === 'push'
          ? activeEvent.payload.pushPayload
          : activeEvent.payload.whatsappPayload;
      try {
        await navigator.clipboard.writeText(JSON.stringify(targetPayload, null, 2));
        showToast('Payload JSON del Transactional Outbox copiado al portapapeles.');
      } catch {
        showToast('No fue posible copiar automáticamente al portapapeles.', true);
      }
    }
  });

  // Filtros en vivo del Panel Administrativo (Pestaña 3)
  const syncAdminFiltersFromDom = () => {
    state.adminFilters = {
      agentId: document.getElementById('filter-agent')?.value || '',
      referrerId: document.getElementById('filter-referrer')?.value || '',
      startDate: document.getElementById('filter-start-date')?.value || '',
      endDate: document.getElementById('filter-end-date')?.value || '',
    };
    renderAdminView();
  };

  document.getElementById('filter-agent')?.addEventListener('change', syncAdminFiltersFromDom);
  document.getElementById('filter-referrer')?.addEventListener('change', syncAdminFiltersFromDom);
  document.getElementById('filter-start-date')?.addEventListener('change', syncAdminFiltersFromDom);
  document.getElementById('filter-end-date')?.addEventListener('change', syncAdminFiltersFromDom);

  document.getElementById('btn-clear-filters')?.addEventListener('click', () => {
    state.adminFilters = { agentId: '', referrerId: '', startDate: '', endDate: '' };
    const startEl = document.getElementById('filter-start-date');
    const endEl = document.getElementById('filter-end-date');
    if (startEl) startEl.value = '';
    if (endEl) endEl.value = '';
    renderAll();
  });

  // Gestor de reglas de comisión por Prospectador/Ramo
  document.getElementById('form-commission-rule')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const errorBox = document.getElementById('rule-form-error');
    if (errorBox) errorBox.hidden = true;

    const referrerId = document.getElementById('rule-referrer')?.value || '';
    const branchCode = document.getElementById('rule-branch')?.value || '';
    const rateInput = document.getElementById('rule-rate');
    const noteInput = document.getElementById('rule-note');
    const numericRate = Number(rateInput?.value);

    if (!Number.isFinite(numericRate) || numericRate <= 0 || numericRate > 100) {
      if (errorBox) {
        errorBox.textContent = 'Ingrese un porcentaje de comisión válido mayor a 0 y menor o igual a 100.';
        errorBox.hidden = false;
      }
      rateInput?.focus();
      return;
    }

    const cleanRate = roundCurrency(numericRate);
    const cleanNote = (noteInput?.value || '').trim() || 'Convenio ejecutivo configurado en panel';
    const existingIdx = state.customRules.findIndex(
      (r) => r.referrerId === referrerId && r.branchCode === branchCode
    );

    if (existingIdx >= 0) {
      state.customRules[existingIdx] = {
        ...state.customRules[existingIdx],
        ratePercent: cleanRate,
        active: true,
        note: cleanNote,
      };
    } else {
      state.customRules.push({
        id: `rule-${referrerId}-${branchCode.toLowerCase()}-${Date.now()}`,
        referrerId,
        branchCode,
        ratePercent: cleanRate,
        active: true,
        note: cleanNote,
      });
    }

    recalculateOpenPipelineCommissions();
    if (rateInput) rateInput.value = '';
    if (noteInput) noteInput.value = '';
    renderAll();

    const refUser = findUserById(referrerId);
    const branch = findBranchByCode(branchCode);
    showToast(
      `Comisión actualizada a ${formatPercent(cleanRate)} para ${refUser?.fullName || referrerId} en ${
        branch?.name || branchCode
      }.`
    );
  });

  document.getElementById('tbody-custom-rules')?.addEventListener('click', (event) => {
    const deleteBtn = event.target.closest('[data-action="delete-rule"]');
    if (!deleteBtn) return;
    const ruleId = deleteBtn.dataset.ruleId;
    state.customRules = state.customRules.filter((r) => r.id !== ruleId);
    recalculateOpenPipelineCommissions();
    renderAll();
    showToast('Convenio eliminado; el prospectador vuelve a la comisión base del ramo.');
  });

  // Alta dinámica de nuevo producto asegurador (`registerInsuranceBranch`)
  document.getElementById('form-new-branch')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const errorBox = document.getElementById('branch-form-error');
    if (errorBox) errorBox.hidden = true;

    const codeInput = document.getElementById('branch-code');
    const rateInput = document.getElementById('branch-rate');
    const nameInput = document.getElementById('branch-name');

    try {
      const updatedBranches = registerInsuranceBranch(state.branches, {
        code: codeInput?.value || '',
        name: nameInput?.value || '',
        defaultCommissionRate: Number(rateInput?.value),
      });

      state.branches = [...updatedBranches];
      event.currentTarget.reset();
      renderAll();
      showToast('Nuevo ramo asegurador incorporado al catálogo y habilitado en las 3 vistas.');
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err instanceof Error ? err.message : String(err);
        errorBox.hidden = false;
      }
      codeInput?.focus();
    }
  });

  // Exportación CSV y Reporte PDF
  document.getElementById('btn-export-csv')?.addEventListener('click', exportAdminReportCsv);
  document.getElementById('btn-export-pdf')?.addEventListener('click', () => {
    setActiveTab('admin', false);
    renderAdminView();
    window.print();
  });
}

function handleStageTransitionSubmit(form) {
  const dossierId = form.dataset.dossierId;
  const oppId = form.dataset.oppId;
  const errorBox = form.querySelector('[data-role="transition-error"]');
  if (errorBox) errorBox.hidden = true;

  const dossierIdx = state.dossiers.findIndex((d) => d.id === dossierId);
  if (dossierIdx === -1) return;
  const currentDossier = state.dossiers[dossierIdx];

  const nextStage = form.querySelector('select[name="nextStage"]')?.value || '';
  const estInput = form.querySelector('input[name="estimatedPremium"]');
  const finInput = form.querySelector('input[name="finalPremium"]');
  const rejInput = form.querySelector('input[name="rejectionReason"]');
  const notesInput = form.querySelector('input[name="notes"]');

  const rawEst = estInput?.value.trim() ?? '';
  const rawFin = finInput?.value.trim() ?? '';

  try {
    // Validaciones explícitas de interfaz alineadas con las invariantes del dominio
    if (nextStage === STAGE_CODES.EN_COTIZACION && (!rawEst || Number(rawEst) <= 0)) {
      estInput?.focus();
      throw new Error(
        'Para avanzar a "En Proceso de Cotización" ingrese una prima anual estimada mayor a $0 MXN.'
      );
    }

    if (nextStage === STAGE_CODES.POLIZA_PAGADA && (!rawFin || Number(rawFin) <= 0)) {
      finInput?.focus();
      throw new Error(
        'Para marcar "Póliza Emitida y Pagada" ingrese la prima anual efectivamente pagada (> $0 MXN).'
      );
    }

    if (nextStage === STAGE_CODES.DESCARTADO && (rejInput?.value.trim().length || 0) < 5) {
      rejInput?.focus();
      throw new Error(
        'Para descartar la oportunidad debe capturar un motivo verificable de al menos 5 caracteres.'
      );
    }

    const updatedDossier = transitionDossierOpportunity(currentDossier, oppId, {
      nextStage,
      actorId: state.activeAgentId,
      actorRole: ROLES.VENDEDOR,
      estimatedPremium: rawEst !== '' ? Number(rawEst) : undefined,
      finalPremium: rawFin !== '' ? Number(rawFin) : undefined,
      rejectionReason: nextStage === STAGE_CODES.DESCARTADO ? rejInput?.value : undefined,
      notes: notesInput?.value || '',
      customRules: state.customRules,
      branches: state.branches,
    });

    state.dossiers = state.dossiers.map((d, idx) => (idx === dossierIdx ? updatedDossier : d));
    const updatedOpp = updatedDossier.opportunities.find((o) => o.id === oppId);
    if (updatedOpp) {
      pushOutboxAlert({ dossier: updatedDossier, opportunity: updatedOpp });
    }

    renderAll();
    const stageMeta = STAGE_BY_CODE[nextStage];
    showToast(
      `${updatedDossier.fullName} avanzó a "${stageMeta?.label || nextStage}". Notificación WhatsApp + Push despachada al Outbox.`
    );
  } catch (err) {
    if (errorBox) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
      errorBox.hidden = false;
    }
  }
}

function handleCrossSellSubmit(form) {
  const dossierId = form.dataset.dossierId;
  const errorBox = form.querySelector('[data-role="cs-error"]');
  if (errorBox) errorBox.hidden = true;

  const dossierIdx = state.dossiers.findIndex((d) => d.id === dossierId);
  if (dossierIdx === -1) return;
  const currentDossier = state.dossiers[dossierIdx];

  const branchCode = form.querySelector('select[name="branchCode"]')?.value || '';
  const notes = form.querySelector('input[name="notes"]')?.value || '';
  const allowDuplicateBranch = Boolean(
    form.querySelector('input[name="allowDuplicateBranch"]')?.checked
  );

  try {
    const updatedDossier = addCrossSellOpportunity(currentDossier, {
      branchCode,
      actorId: state.activeAgentId,
      actorRole: ROLES.VENDEDOR,
      notes,
      allowDuplicateBranch,
      customRules: state.customRules,
      branches: state.branches,
    });

    state.dossiers = state.dossiers.map((d, idx) => (idx === dossierIdx ? updatedDossier : d));
    state.openCrossSellDossierIds.delete(dossierId);

    const createdOpp = updatedDossier.opportunities[updatedDossier.opportunities.length - 1];
    if (createdOpp) {
      pushOutboxAlert({ dossier: updatedDossier, opportunity: createdOpp });
    }

    const originalReferrer = findUserById(updatedDossier.originalReferrerId);
    const branchMeta = findBranchByCode(branchCode);
    renderAll();
    showToast(
      `Venta cruzada (${branchMeta?.name || branchCode}) abierta: comisión atribuida inmutablemente a ${
        originalReferrer?.fullName || updatedDossier.originalReferrerId
      }.`
    );
  } catch (err) {
    if (errorBox) {
      errorBox.textContent = err instanceof Error ? err.message : String(err);
      errorBox.hidden = false;
    }
  }
}

/* ============================================================================
   ARRANQUE DE LA APLICACIÓN
   ============================================================================ */
function boot() {
  initializeDemoState();
  bindEvents();

  const initialTab = new URLSearchParams(window.location.search).get('vista');
  if (initialTab) {
    setActiveTab(initialTab, false);
  }
  renderAll();
}

boot();
