import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import {
  readHistoricalReplayBaseline,
  writeHistoricalReplayBaselineReport
} from '../services/historical-replay-baseline-service.js';

export async function runHistoricalReplayBaseline(args) {
  const projectsRoot = resolve(option(args, 'projects-root'));
  const report = await readHistoricalReplayBaseline(projectsRoot, {
    from: option(args, 'from'),
    through: option(args, 'through'),
    timeZoneOffset: option(args, 'time-zone-offset', { required: false }) ?? '+08:00'
  });
  const reportDirectory = option(args, 'report-dir', { required: false });
  if (!reportDirectory) return report;
  const resolvedReportDirectory = resolve(reportDirectory);
  const fromProjects = relative(projectsRoot, resolvedReportDirectory);
  if (fromProjects === '' || (!isAbsolute(fromProjects) && fromProjects !== '..' && !fromProjects.startsWith(`..${sep}`))) {
    throw new Error('report-dir must stay outside projects-root so offline replay cannot modify project evidence');
  }
  return { report, outputs: await writeHistoricalReplayBaselineReport(resolvedReportDirectory, report) };
}
