import type { AdrActivity, Snapshot } from '../shared/work';
import { useAdrWorkspace } from './adr-workspace';
import { AdrTimelineContent } from './adr-timeline-entry';

export function AdrTimelineActivity({ activity, snapshot, scope }: { activity: AdrActivity; snapshot: Snapshot; scope: string }) {
  const { openAdr } = useAdrWorkspace();
  return <AdrTimelineContent activity={activity} snapshot={snapshot} onOpen={openAdr} scope={scope} />;
}
