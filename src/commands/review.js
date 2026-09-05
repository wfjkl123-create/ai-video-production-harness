import { resolve } from 'node:path';
import { approveArtifact, rejectArtifact, submitForReview } from '../services/review-service.js';
import { option } from './args.js';

function values(args) {
  return {
    root: resolve(option(args, 'project')),
    artifactId: option(args, 'artifact')
  };
}

export async function runSubmitReview(args) {
  const { root, artifactId } = values(args);
  return submitForReview(root, artifactId);
}

export async function runApprove(args) {
  const { root, artifactId } = values(args);
  return approveArtifact(root, artifactId, option(args, 'note'));
}

export async function runReject(args) {
  const { root, artifactId } = values(args);
  return rejectArtifact(root, artifactId, option(args, 'note'), option(args, 'correction'));
}
