import { isAbsolute, relative, resolve, sep } from 'node:path';

import { option } from './args.js';
import { readHistoricalReplayBaseline } from '../services/historical-replay-baseline-service.js';
import { writeShadowFunnelProjectionReport } from '../services/shadow-funnel-projection-service.js';

export async function runShadowFunnelProjection(args) {
  const projectsRoot = resolve(option(args, 'projects-root'));
  const from = option(args, 'from');
  const through = option(args, 'through');
  const baseline = await readHistoricalReplayBaseline(projectsRoot, {
    from, through, timeZoneOffset: option(args, 'time-zone-offset', { required: false }) ?? '+08:00'
  });
  const report = baseline.shadowFunnel;
  const reportDirectory = option(args, 'report-dir', { required: false });
  if (!reportDirectory) return report;
  const resolvedReportDirectory = resolve(reportDirectory);
  const fromProjects = relative(projectsRoot, resolvedReportDirectory);
  if (fromProjects === '' || (!isAbsolute(fromProjects) && fromProjects !== '..' && !fromProjects.startsWith(`..${sep}`))) {
    throw new Error('report-dir must stay outside projects-root so shadow projection cannot modify project evidence');
  }
  return {
    report,
    outputs: await writeShadowFunnelProjectionReport(resolvedReportDirectory, report, `${from}_to_${through}`)
  };
}
