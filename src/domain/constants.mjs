/**
 * Catálogo normativo del dominio IngresoCerteza.
 *
 * Las colecciones base se congelan en memoria (`Object.freeze`) para evitar mutaciones
 * accidentales entre el simulador web y el motor de cálculo; el alta dinámica de ramos
 * por parte de Administración produce siempre una nueva instantánea inmutable.
 */

export const ROLES = Object.freeze({
  PROSPECTADOR: 'PROSPECTADOR',
  VENDEDOR: 'VENDEDOR',
  ADMIN: 'ADMIN',
});

export const COMMISSION_STATUS = Object.freeze({
  PENDIENTE: 'PENDIENTE',
  EN_PROCESO: 'EN_PROCESO',
  LISTA_PARA_COBRO: 'LISTA_PARA_COBRO',
  CANCELADA: 'CANCELADA',
});

export const STAGE_CODES = Object.freeze({
  NUEVO: 'NUEVO',
  PRIMER_CONTACTO: 'PRIMER_CONTACTO',
  CITA_AGENDADA: 'CITA_AGENDADA',
  EN_COTIZACION: 'EN_COTIZACION',
  SOLICITUD_LLENADA: 'SOLICITUD_LLENADA',
  POLIZA_PAGADA: 'POLIZA_PAGADA',
  DESCARTADO: 'DESCARTADO',
});

export const BRANCH_CODES = Object.freeze({
  VIDA: 'VIDA',
  AHORRO: 'AHORRO',
  PPR: 'PPR',
  GASTOS_MEDICOS: 'GASTOS_MEDICOS',
  AUTO: 'AUTO',
  HOGAR: 'HOGAR',
  MASCOTAS: 'MASCOTAS',
});

export const INSURANCE_BRANCHES = Object.freeze([
  Object.freeze({
    code: BRANCH_CODES.VIDA,
    name: 'Seguro de Vida',
    defaultCommissionRate: 15,
    active: true,
  }),
  Object.freeze({
    code: BRANCH_CODES.AHORRO,
    name: 'Seguro de Ahorro',
    defaultCommissionRate: 12,
    active: true,
  }),
  Object.freeze({
    code: BRANCH_CODES.PPR,
    name: 'Plan Personal de Retiro (PPR)',
    defaultCommissionRate: 14,
    active: true,
  }),
  Object.freeze({
    code: BRANCH_CODES.GASTOS_MEDICOS,
    name: 'Gastos Médicos Mayores',
    defaultCommissionRate: 12,
    active: true,
  }),
  Object.freeze({
    code: BRANCH_CODES.AUTO,
    name: 'Seguro de Auto',
    defaultCommissionRate: 10,
    active: true,
  }),
  Object.freeze({
    code: BRANCH_CODES.HOGAR,
    name: 'Seguro de Hogar',
    defaultCommissionRate: 11,
    active: true,
  }),
  Object.freeze({
    code: BRANCH_CODES.MASCOTAS,
    name: 'Seguro de Mascotas',
    defaultCommissionRate: 8,
    active: true,
  }),
]);

/**
 * Máquina lineal de 7 etapas (RFP 4.2).
 * Solo las etapas 6 y 7 cierran el ciclo comercial; reabrirlas exige privilegio ADMIN
 * para impedir alteraciones unilaterales sobre pólizas ya conciliadas o bajas auditadas.
 */
export const COMMERCIAL_STAGES = Object.freeze([
  Object.freeze({
    code: STAGE_CODES.NUEVO,
    stepNumber: 1,
    label: 'Prospecto Nuevo (Registrado)',
    isTerminal: false,
  }),
  Object.freeze({
    code: STAGE_CODES.PRIMER_CONTACTO,
    stepNumber: 2,
    label: '1er Contacto / Llamada Realizada',
    isTerminal: false,
  }),
  Object.freeze({
    code: STAGE_CODES.CITA_AGENDADA,
    stepNumber: 3,
    label: 'Cita Agendada',
    isTerminal: false,
  }),
  Object.freeze({
    code: STAGE_CODES.EN_COTIZACION,
    stepNumber: 4,
    label: 'En Proceso de Cotización',
    isTerminal: false,
  }),
  Object.freeze({
    code: STAGE_CODES.SOLICITUD_LLENADA,
    stepNumber: 5,
    label: 'Solicitud Llenada / En Suscripción',
    isTerminal: false,
  }),
  Object.freeze({
    code: STAGE_CODES.POLIZA_PAGADA,
    stepNumber: 6,
    label: 'Póliza Emitida y Pagada',
    isTerminal: true,
  }),
  Object.freeze({
    code: STAGE_CODES.DESCARTADO,
    stepNumber: 7,
    label: 'No Interesado / Descartado',
    isTerminal: true,
  }),
]);

export const STAGE_BY_CODE = Object.freeze(
  Object.fromEntries(COMMERCIAL_STAGES.map((stage) => [stage.code, stage]))
);

/**
 * Registra un nuevo producto asegurador sin alterar el catálogo previo (RFP 3.C).
 * Rechaza colisiones de código para preservar la integridad histórica de comisiones ya pactadas.
 */
export function registerInsuranceBranch(branches = INSURANCE_BRANCHES, newBranch = {}) {
  if (!Array.isArray(branches)) {
    throw new TypeError('El catálogo base de ramos debe ser un arreglo.');
  }

  const rawCode = typeof newBranch.code === 'string' ? newBranch.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9_]{2,32}$/.test(rawCode)) {
    throw new Error(
      `Código de ramo inválido ("${newBranch.code ?? ''}"): use 2-32 caracteres alfanuméricos o guion bajo.`
    );
  }

  const trimmedName = typeof newBranch.name === 'string' ? newBranch.name.trim() : '';
  if (trimmedName.length < 3) {
    throw new Error('El nombre comercial del ramo debe contener al menos 3 caracteres.');
  }

  const rate = Number(newBranch.defaultCommissionRate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    throw new Error('El porcentaje de comisión base debe ser mayor a 0 y menor o igual a 100.');
  }

  if (branches.some((branch) => branch.code === rawCode)) {
    throw new Error(`El ramo "${rawCode}" ya existe en el catálogo.`);
  }

  const created = Object.freeze({
    code: rawCode,
    name: trimmedName,
    defaultCommissionRate: Math.round((rate + Number.EPSILON) * 100) / 100,
    active: newBranch.active !== undefined ? Boolean(newBranch.active) : true,
  });

  return Object.freeze([...branches, created]);
}
