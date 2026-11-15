import { Activity, ListTree, MessageSquare } from "lucide-react";
import { TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "../lib/utils";

interface PluginTab { value: string; label: string }
export function resolveTaskDetailTab(selected: string, taskChatShellEnabled: boolean, pluginTabs: readonly PluginTab[]): string {
  return taskChatShellEnabled && !pluginTabs.some(tab => tab.value === selected) ? "chat" : selected;
}

/** Existing plugins stay reachable in both the current task shell and classic task tabs. */
export function IssueDetailTabBar({ taskChatShellEnabled, pluginTabs, className }: {
  taskChatShellEnabled: boolean;
  pluginTabs: readonly PluginTab[];
  className?: string;
}) {
  if (taskChatShellEnabled && pluginTabs.length === 0) return null;
  return <TabsList variant="line" className={cn("w-full justify-start gap-1", className)}>
    <TabsTrigger value="chat" className="gap-1.5"><MessageSquare className="h-3.5 w-3.5" />Chat</TabsTrigger>
    {!taskChatShellEnabled ? <>
      <TabsTrigger value="activity" className="gap-1.5"><Activity className="h-3.5 w-3.5" />Activity</TabsTrigger>
      <TabsTrigger value="related-work" className="gap-1.5"><ListTree className="h-3.5 w-3.5" />Related work</TabsTrigger>
    </> : null}
    {pluginTabs.map(item => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
  </TabsList>;
}
