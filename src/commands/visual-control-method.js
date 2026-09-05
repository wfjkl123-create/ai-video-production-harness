import { option } from './args.js';
import { buildVisualControlChoiceQuestion, detectVisualControlChoice, resolveRemakeControlModes, resolveVisualControlMethod } from '../services/visual-control-method-service.js';

export function runVisualControlMethod(args) {
  const request = option(args, 'request');
  const method = option(args, 'method', { required: false });
  const firstFramePolicy = option(args, 'first-frame-policy', { required: false });
  if (!method && detectVisualControlChoice(request)) return buildVisualControlChoiceQuestion();
  if (!method) return { status: 'no_choice_required', reason: 'request does not require remake-control selection or already names a control method' };
  if (['storyboard_control', 'depth_control', 'native_source', 'koc_remake'].includes(method)) {
    return { status: 'selected', ...resolveRemakeControlModes([method], { firstFramePolicy }) };
  }
  return { status: 'selected', ...resolveVisualControlMethod(method) };
}
