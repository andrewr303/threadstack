import React from 'react';
import type { AgentRunFacts } from '../../../core/schema.js';
import { normalizePullRequestUrl } from '../../../core/repository.js';

/** Files and commands shown before "and N more". */
export const AGENT_RUN_LIST_LIMIT = 15;

const PR_STATE_WORDS: Record<AgentRunFacts['pullRequests'][number]['state'], string> = {
  open: 'open',
  merged: 'merged',
  closed: 'closed',
  unknown: 'state unknown',
};

const OUTCOME_WORDS: Record<AgentRunFacts['commandsRun'][number]['outcome'], string> = {
  ok: 'ok',
  failed: 'failed',
  unknown: 'unknown',
};

const TEST_WORDS: Record<AgentRunFacts['tests']['status'], string> = {
  passing: 'Passing',
  failing: 'Failing',
  not_run: 'Not run',
  unknown: 'Unknown',
};

const BLOCKED_WORDS: Record<Exclude<AgentRunFacts['blockedOn'], 'none'>, string> = {
  permission: 'Your approval',
  input: 'Your answer',
  ci: 'CI checks',
  external: 'Something outside the session',
};

function showsTests(run: AgentRunFacts): boolean {
  return run.tests.status !== 'unknown' || Boolean(run.tests.detail);
}

/** Whether the facts say anything worth a block. A run with nothing but a run state does not. */
export function hasAgentRunContent(run: AgentRunFacts | null | undefined): run is AgentRunFacts {
  if (!run || typeof run !== 'object') return false;
  return Boolean(
    run.repository ||
      run.branch ||
      run.pullRequests?.length ||
      run.filesChanged?.length ||
      run.commandsRun?.length ||
      showsTests(run) ||
      (run.blockedOn && run.blockedOn !== 'none')
  );
}

function pullRequestNumber(url: string): string | null {
  return url.match(/\/(\d+)\/?$/)?.[1] ?? null;
}

/** What a coding-agent session did, as the analysis read it from the transcript. */
export function AgentRunBlock({ run, headingId }: { run: AgentRunFacts; headingId: string }) {
  const files = run.filesChanged ?? [];
  const commands = run.commandsRun ?? [];
  const pullRequests = run.pullRequests ?? [];
  return (
    <section className="tk-thr-run" aria-labelledby={headingId} data-evidence-location="agent-run">
      <h4 className="tk-overview-h4" id={headingId}>
        Agent run
      </h4>
      <dl className="tk-thr-run-grid">
        {run.repository && (
          <>
            <dt>Repository</dt>
            <dd className="tk-thr-mono">{run.repository}</dd>
          </>
        )}
        {run.branch && (
          <>
            <dt>Branch</dt>
            <dd className="tk-thr-mono">{run.branch}</dd>
          </>
        )}
        {pullRequests.length > 0 && (
          <>
            <dt>Pull requests</dt>
            <dd>
              <ul className="tk-thr-run-list">
                {pullRequests.map((pr) => {
                  const href = normalizePullRequestUrl(pr.url);
                  const number = pullRequestNumber(href ?? pr.url);
                  return (
                    <li key={pr.url}>
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer">
                          {number ? `Pull request #${number}` : 'Pull request'}
                        </a>
                      ) : (
                        <span>{pr.url}</span>
                      )}{' '}
                      <span className="tk-muted">({PR_STATE_WORDS[pr.state] ?? PR_STATE_WORDS.unknown})</span>
                    </li>
                  );
                })}
              </ul>
            </dd>
          </>
        )}
        {files.length > 0 && (
          <>
            <dt>Files changed</dt>
            <dd>
              <ul className="tk-thr-run-list tk-thr-files">
                {files.slice(0, AGENT_RUN_LIST_LIMIT).map((file) => (
                  <li key={file} className="tk-thr-mono" title={file}>
                    {file}
                  </li>
                ))}
              </ul>
              {files.length > AGENT_RUN_LIST_LIMIT && (
                <p className="tk-muted">and {files.length - AGENT_RUN_LIST_LIMIT} more</p>
              )}
            </dd>
          </>
        )}
        {commands.length > 0 && (
          <>
            <dt>Commands</dt>
            <dd>
              <ul className="tk-thr-run-list tk-thr-commands">
                {commands.slice(0, AGENT_RUN_LIST_LIMIT).map((c, i) => (
                  <li key={`${i}-${c.command}`}>
                    <span className="tk-thr-mono tk-thr-command" title={c.command}>
                      {c.command}
                    </span>
                    <span className="tk-thr-outcome" data-outcome={c.outcome}>
                      {OUTCOME_WORDS[c.outcome] ?? OUTCOME_WORDS.unknown}
                    </span>
                  </li>
                ))}
              </ul>
              {commands.length > AGENT_RUN_LIST_LIMIT && (
                <p className="tk-muted">and {commands.length - AGENT_RUN_LIST_LIMIT} more</p>
              )}
            </dd>
          </>
        )}
        {showsTests(run) && (
          <>
            <dt>Tests</dt>
            <dd>
              {TEST_WORDS[run.tests.status]}
              {run.tests.detail ? `. ${run.tests.detail}` : ''}
            </dd>
          </>
        )}
        {run.blockedOn !== 'none' && run.blockedOn in BLOCKED_WORDS && (
          <>
            <dt>Waiting on</dt>
            <dd>{BLOCKED_WORDS[run.blockedOn as keyof typeof BLOCKED_WORDS]}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
