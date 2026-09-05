export function preciseCapabilityArtifact(state) {
  if (!state || typeof state !== 'object' || !state.verifiedCapabilityManifestId || state.directorRoutingVersion !== 1) return null;
  return (state.artifacts ?? []).find(item => item.id === state.verifiedCapabilityManifestId
    && item.type === 'capability_manifest'
    && item.status === 'locked'
    && typeof item.invalidatedByScopeRevisionId !== 'string'
    && item.routePrecision === 'explicit_v2'
    && item.storyPlanSchemaVersion === 2) ?? null;
}

export function hasPreciseVerifiedDirectorRoute(state) {
  return preciseCapabilityArtifact(state) !== null;
}
