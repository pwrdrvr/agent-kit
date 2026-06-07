// ACP runtime capabilities: the models, modes, and config-options an agent
// advertises at `initialize` / `session/new` / `session/load`, and how those
// merge over the initialize snapshot. These are package-internal metadata
// surfaced through client callbacks (NOT a NormalizedThreadEvent) — a host that
// renders a model/mode picker reads them. camel/snake tolerant throughout, and
// new data merges OVER the initialize snapshot without dropping prior fields.
//
// Ported from PwrAgnt acp-runtime-capabilities.ts, retargeted off @pwragent/shared
// onto neutral local types.

import { asRecord, readBoolean, readString } from "./content";

export type AcpRuntimeConfigOptionValue = {
  value: string;
  label?: string;
  description?: string;
};

export type AcpRuntimeConfigOption = {
  id: string;
  label: string;
  description?: string;
  type: "select";
  category?: string;
  currentValue?: string;
  values: AcpRuntimeConfigOptionValue[];
};

export type AcpRuntimeMode = {
  id: string;
  label: string;
  description?: string;
};

export type AcpRuntimeModel = {
  id: string;
  label?: string;
  description?: string;
  /** True when this is the model the agent reports as current/default
   *  (`currentModelId`). At most one model in a list is flagged; absent when the
   *  agent advertises models but no current id. A host can pre-select this and
   *  render it as the "(default)" option. */
  isDefault?: boolean;
};

export type AcpRuntimeModes = {
  availableModes: AcpRuntimeMode[];
  currentModeId?: string;
};

export type AcpRuntimeModels = {
  availableModels: AcpRuntimeModel[];
  currentModelId?: string;
};

export type AcpRuntimeAgentInfo = {
  name?: string;
  title?: string;
  version?: string;
};

export type AcpRuntimeAgentCapabilities = {
  loadSession?: boolean;
  sessionHistoryReplay?: boolean;
  session?: { close?: boolean; cancel?: boolean };
  raw?: unknown;
};

export type AcpRuntimeCapabilitiesSource =
  | "initialize"
  | "session-new"
  | "session-load";

export type AcpRuntimeCapabilities = {
  source: AcpRuntimeCapabilitiesSource;
  discoveredAt: number;
  checkedAt: number;
  protocolVersion?: number;
  agentInfo?: AcpRuntimeAgentInfo;
  agentCapabilities?: AcpRuntimeAgentCapabilities;
  configOptions?: AcpRuntimeConfigOption[];
  modes?: AcpRuntimeModes;
  models?: AcpRuntimeModels;
};

export type AcpSessionRuntimeState = {
  updatedAt?: number;
  currentModeId?: string;
  currentModelId?: string;
  configValues?: Record<string, string>;
};

export function normalizeAcpRuntimeCapabilities(params: {
  value: unknown;
  now: number;
  source: AcpRuntimeCapabilitiesSource;
  initialize?: AcpRuntimeCapabilities;
}): AcpRuntimeCapabilities | undefined {
  const record = asRecord(params.value);
  if (!record) {
    return params.initialize;
  }

  const configOptions = readConfigOptions(record.configOptions ?? record.config_options);
  const modes = readModes(record.modes);
  const models = readModels(record.models);
  const agentCapabilities = readAgentCapabilities(
    record.agentCapabilities ?? record.agent_capabilities ?? record.capabilities,
    record.sessionCapabilities ?? record.session_capabilities
  );
  const agentInfo = readAgentInfo(record.agentInfo ?? record.agent_info);
  const protocolVersion =
    typeof record.protocolVersion === "number"
      ? record.protocolVersion
      : typeof record.protocol_version === "number"
        ? record.protocol_version
        : params.initialize?.protocolVersion;

  const hasRuntimeData =
    configOptions.length > 0 ||
    Boolean(modes) ||
    Boolean(models) ||
    Boolean(agentCapabilities) ||
    Boolean(agentInfo) ||
    typeof protocolVersion === "number";

  if (!hasRuntimeData && !params.initialize) {
    return undefined;
  }

  const merged: AcpRuntimeCapabilities = {
    source: params.source,
    discoveredAt: params.initialize?.discoveredAt ?? params.now,
    checkedAt: params.now
  };
  if (typeof protocolVersion === "number") merged.protocolVersion = protocolVersion;

  if (agentInfo ?? params.initialize?.agentInfo) {
    merged.agentInfo = { ...params.initialize?.agentInfo, ...agentInfo };
  }
  if (agentCapabilities ?? params.initialize?.agentCapabilities) {
    merged.agentCapabilities = {
      ...params.initialize?.agentCapabilities,
      ...agentCapabilities
    };
  }
  if (configOptions.length > 0) {
    merged.configOptions = configOptions;
  } else if (params.initialize?.configOptions) {
    merged.configOptions = params.initialize.configOptions;
  }
  if (modes) {
    merged.modes = modes;
  } else if (params.initialize?.modes) {
    merged.modes = params.initialize.modes;
  }
  if (models) {
    merged.models = models;
  } else if (params.initialize?.models) {
    merged.models = params.initialize.models;
  }

  return merged;
}

export function acpRuntimeSupportsSessionLoad(
  capabilities: AcpRuntimeCapabilities | undefined
): boolean {
  return capabilities?.agentCapabilities?.loadSession !== false;
}

export function acpSessionRuntimeStateFromCapabilities(
  capabilities: AcpRuntimeCapabilities | undefined,
  now: number
): AcpSessionRuntimeState | undefined {
  if (!capabilities) {
    return undefined;
  }
  const configValues = Object.fromEntries(
    (capabilities.configOptions ?? []).flatMap((option) =>
      typeof option.currentValue === "string"
        ? [[option.id, option.currentValue] as const]
        : []
    )
  );
  const state: AcpSessionRuntimeState = { updatedAt: now };
  if (Object.keys(configValues).length > 0) state.configValues = configValues;
  if (capabilities.modes?.currentModeId) {
    state.currentModeId = capabilities.modes.currentModeId;
  }
  if (capabilities.models?.currentModelId) {
    state.currentModelId = capabilities.models.currentModelId;
  }
  return Object.keys(state).length > 1 ? state : undefined;
}

/** Runtime-state change carried inside a session/update (mode/model/config). */
export function acpSessionRuntimeStateFromUpdate(
  update: Record<string, unknown>,
  now: number
): AcpSessionRuntimeState | undefined {
  const kind =
    readString(update, "sessionUpdate") ??
    readString(update, "session_update") ??
    readString(update, "kind") ??
    readString(update, "type");
  if (kind === "agent_message_chunk") {
    const modeId = readModeUpdateMarker(update);
    return modeId ? { currentModeId: modeId, updatedAt: now } : undefined;
  }
  if (kind === "current_mode_update") {
    const currentModeId =
      readString(update, "currentModeId") ??
      readString(update, "current_mode_id") ??
      readString(update, "modeId") ??
      readString(update, "mode_id") ??
      readString(update, "id");
    return currentModeId ? { currentModeId, updatedAt: now } : undefined;
  }
  if (kind === "config_option_update") {
    const configOption = asRecord(update.configOption ?? update.config_option) ?? update;
    const id =
      readString(configOption, "id") ??
      readString(configOption, "configOptionId") ??
      readString(configOption, "configId");
    const value =
      readString(configOption, "currentValue") ?? readString(configOption, "value");
    return id && value ? { configValues: { [id]: value }, updatedAt: now } : undefined;
  }
  return undefined;
}

export function mergeAcpRuntimeState(
  existing: AcpSessionRuntimeState | undefined,
  update: AcpSessionRuntimeState
): AcpSessionRuntimeState {
  return {
    ...existing,
    ...update,
    configValues: {
      ...(existing?.configValues ?? {}),
      ...(update.configValues ?? {})
    }
  };
}

/** Resolve the human-facing label for a mode id from the capabilities snapshot. */
export function modeLabelFor(
  capabilities: AcpRuntimeCapabilities | undefined,
  modeId: string
): string | undefined {
  return capabilities?.modes?.availableModes.find((mode) => mode.id === modeId)?.label;
}

function readModeUpdateMarker(update: Record<string, unknown>): string | undefined {
  const text = readString(update, "content") ?? readString(update, "text");
  const match = text?.trim().match(/^\[MODE_UPDATE\]\s*([A-Za-z0-9_-]+)\s*$/);
  return match?.[1];
}

function readConfigOptions(value: unknown): AcpRuntimeConfigOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id =
      readString(record, "id") ??
      readString(record, "configOptionId") ??
      readString(record, "configId");
    if (!record || !id) {
      return [];
    }
    const values = readConfigOptionValues(record.values ?? record.options);
    if (values.length === 0) {
      return [];
    }
    const option: AcpRuntimeConfigOption = {
      id,
      label:
        readString(record, "name") ??
        readString(record, "label") ??
        readString(record, "title") ??
        id,
      type: "select",
      values
    };
    const description = readString(record, "description");
    if (description !== undefined) option.description = description;
    const category = readString(record, "category");
    if (category !== undefined) option.category = category;
    const currentValue =
      readString(record, "currentValue") ?? readString(record, "value");
    if (currentValue !== undefined) option.currentValue = currentValue;
    return [option];
  });
}

function readConfigOptionValues(value: unknown): AcpRuntimeConfigOptionValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const optionValue =
      readString(record, "value") ??
      readString(record, "id") ??
      readString(record, "optionId");
    if (!record || !optionValue) {
      return [];
    }
    const normalized: AcpRuntimeConfigOptionValue = { value: optionValue };
    const label =
      readString(record, "name") ??
      readString(record, "label") ??
      readString(record, "title");
    if (label !== undefined) normalized.label = label;
    const description = readString(record, "description");
    if (description !== undefined) normalized.description = description;
    return [normalized];
  });
}

function readModes(value: unknown): AcpRuntimeModes | undefined {
  const record = asRecord(value);
  const modes = Array.isArray(record?.availableModes)
    ? record.availableModes.flatMap(readMode)
    : [];
  if (modes.length === 0) {
    return undefined;
  }
  const result: AcpRuntimeModes = { availableModes: modes };
  const currentModeId = readString(record, "currentModeId");
  if (currentModeId !== undefined) result.currentModeId = currentModeId;
  return result;
}

function readMode(value: unknown): AcpRuntimeMode[] {
  const record = asRecord(value);
  const id = readString(record, "id") ?? readString(record, "modeId");
  if (!record || !id) {
    return [];
  }
  const mode: AcpRuntimeMode = {
    id,
    label: readString(record, "name") ?? readString(record, "label") ?? id
  };
  const description = readString(record, "description");
  if (description !== undefined) mode.description = description;
  return [mode];
}

function readModels(value: unknown): AcpRuntimeModels | undefined {
  const record = asRecord(value);
  const models = Array.isArray(record?.availableModels)
    ? record.availableModels.flatMap(readModel)
    : [];
  if (models.length === 0) {
    return undefined;
  }
  const result: AcpRuntimeModels = { availableModels: models };
  const currentModelId =
    readString(record, "currentModelId") ?? readString(record, "modelId");
  if (currentModelId !== undefined) {
    result.currentModelId = currentModelId;
    // Flag the agent's protocol-confirmed default so a host can pre-select it
    // and label it "(default)" without re-deriving from currentModelId.
    const defaultModel = models.find((model) => model.id === currentModelId);
    if (defaultModel) defaultModel.isDefault = true;
  }
  return result;
}

function readModel(value: unknown): AcpRuntimeModel[] {
  const record = asRecord(value);
  const id = readString(record, "modelId") ?? readString(record, "id");
  if (!record || !id) {
    return [];
  }
  const model: AcpRuntimeModel = { id };
  const label = readString(record, "name") ?? readString(record, "label");
  if (label !== undefined) model.label = label;
  const description = readString(record, "description");
  if (description !== undefined) model.description = description;
  return [model];
}

function readAgentCapabilities(
  value: unknown,
  sessionCapabilitiesValue?: unknown
): AcpRuntimeAgentCapabilities | undefined {
  const record = asRecord(value);
  const sessionCapabilities = asRecord(sessionCapabilitiesValue);
  const sessionMeta = asRecord(sessionCapabilities?._meta);
  const kimiMeta = asRecord(sessionMeta?.kimi);
  if (!record && !sessionCapabilities) {
    return undefined;
  }
  const loadSession =
    readBoolean(record, "loadSession") ??
    readBoolean(record, "load_session") ??
    readBoolean(asRecord(record?.session), "load");
  const close = readBoolean(asRecord(record?.session), "close");
  const cancel = readBoolean(asRecord(record?.session), "cancel");
  const sessionHistoryReplay =
    readBoolean(kimiMeta, "sessionHistoryReplay") ??
    readBoolean(kimiMeta, "session_history_replay");

  const capabilities: AcpRuntimeAgentCapabilities = {
    raw: record ?? sessionCapabilities
  };
  if (loadSession !== undefined) capabilities.loadSession = loadSession;
  if (sessionHistoryReplay !== undefined) {
    capabilities.sessionHistoryReplay = sessionHistoryReplay;
  }
  if (close !== undefined || cancel !== undefined) {
    capabilities.session = {
      ...(close !== undefined ? { close } : {}),
      ...(cancel !== undefined ? { cancel } : {})
    };
  }
  return capabilities;
}

function readAgentInfo(value: unknown): AcpRuntimeAgentInfo | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const agentInfo: AcpRuntimeAgentInfo = {};
  const name = readString(record, "name");
  if (name !== undefined) agentInfo.name = name;
  const title = readString(record, "title");
  if (title !== undefined) agentInfo.title = title;
  const version = readString(record, "version");
  if (version !== undefined) agentInfo.version = version;
  return Object.keys(agentInfo).length > 0 ? agentInfo : undefined;
}
