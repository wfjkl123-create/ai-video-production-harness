import { isAbsolute, relative, resolve, sep } from 'node:path';
import { option } from './args.js';
import { readHistoricalReplayBaseline } from '../services/historical-replay-baseline-service.js';
import {
  readLegacyEvidencePortfolio,
  writeLegacyEvidencePortfolioReport
} from '../services/legacy-evidence-adapter-service.js';

export async function runLegacyEvidenceAdapter(args) {
  const projectsRoot = resolve(option(args, 'projects-root'));
  const from = option(args, 'from');
  const through = option(args, 'through');
  const baseline = await readHistoricalReplayBaseline(projectsRoot, {
    from, through, timeZoneOffset: option(args, 'time-zone-offset', { required: false }) ?? '+08:00'
  });
  const portfolio = await readLegacyEvidencePortfolio(projectsRoot, baseline.projects.map(project => project.slug));
  const reportDirectory = option(args, 'report-dir', { required: false });
  if (!reportDirectory) return portfolio;
  const resolvedReportDirectory = resolve(reportDirectory);
  const fromProjects = relative(projectsRoot, resolvedReportDirectory);
  if (fromProjects === '' || (!isAbsolute(fromProjects) && fromProjects !== '..' && !fromProjects.startsWith(`..${sep}`))) {
    throw new Error('report-dir must stay outside projects-root so evidence adaptation cannot modify project evidence');
  }
  return {
    portfolio,
    outputs: await writeLegacyEvidencePortfolioReport(resolvedReportDirectory, portfolio, `${from}_to_${through}`)
  };
}
