import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { toPng, toSvg } from "html-to-image";
import "@xyflow/react/dist/style.css";

/** Pages shown in the graph (aggregates are hidden for a cleaner site map). */
export type GraphPage = {
  nodeId: string;
  title: string;
  category: string;
  url: string;
};

export type GraphEdge = {
  source: string;
  target: string;
};

const NODE_W = 200;
const NODE_H = 64;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

type SitemapNodeData = {
  title: string;
  category: string;
  selected: boolean;
};

function SitemapNodeInner(props: NodeProps) {
  const data = props.data as SitemapNodeData;
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: "8px",
        background: data.selected ? "#eff6ff" : "#ffffff",
        border: data.selected ? "2px solid #2563eb" : "1px solid #cbd5e1",
        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
        minWidth: NODE_W - 4,
        maxWidth: NODE_W + 40,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          fontWeight: 600,
          fontSize: "12px",
          color: "#0f172a",
          lineHeight: 1.3,
          wordBreak: "break-word",
        }}
        title={data.title}
      >
        {truncate(data.title, 48)}
      </div>
      <div style={{ fontSize: "10px", color: "#64748b", marginTop: "4px" }}>
        {data.category}
      </div>
    </div>
  );
}

const SitemapNode = memo(SitemapNodeInner);

const nodeTypes = { sitemap: SitemapNode } satisfies NodeTypes;

/**
 * Turn crawl pages + sitemap edges into React Flow nodes/edges, laid out top-down with Dagre.
 */
export function pagesToFlowElements(
  graphPages: GraphPage[],
  graphEdges: GraphEdge[],
  selectedNodeId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  if (graphPages.length === 0) {
    return { nodes: [], edges: [] };
  }

  const idSet = new Set(graphPages.map((p) => p.nodeId));
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: 48,
    ranksep: 72,
    marginx: 24,
    marginy: 24,
  });

  for (const p of graphPages) {
    g.setNode(p.nodeId, { width: NODE_W, height: NODE_H });
  }

  const seenEdge = new Set<string>();
  for (const e of graphEdges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    const k = `${e.source}\t${e.target}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const nodes: Node[] = graphPages.map((p) => {
    const pos = g.node(p.nodeId);
    const x = pos?.x ?? 0;
    const y = pos?.y ?? 0;
    const selected = selectedNodeId === p.nodeId;
    return {
      id: p.nodeId,
      type: "sitemap",
      position: { x: x - NODE_W / 2, y: y - NODE_H / 2 },
      data: {
        title: p.title || p.url,
        category: p.category,
        selected,
      },
      draggable: false,
      selectable: true,
    };
  });

  const edges: Edge[] = [];
  let ei = 0;
  for (const k of seenEdge) {
    const [source, target] = k.split("\t");
    edges.push({
      id: `e-${ei++}`,
      source,
      target,
      type: "smoothstep",
      animated: false,
      style: { stroke: "#94a3b8", strokeWidth: 1.5 },
    });
  }

  return { nodes, edges };
}

function FitViewOnChange({ nodeCount }: { nodeCount: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      fitView({ padding: 0.15, duration: 200 });
    });
    return () => cancelAnimationFrame(id);
  }, [nodeCount, fitView]);
  return null;
}

/**
 * Export the graph viewport (nodes + edges only) as PNG or SVG using html-to-image.
 * Targets `.react-flow__viewport` so MiniMap / Controls stay out of the file.
 */
function GraphExportToolbar({
  flowContainerRef,
}: {
  flowContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const { fitView } = useReactFlow();
  const [busy, setBusy] = useState(false);

  const getViewportEl = useCallback(() => {
    return flowContainerRef.current?.querySelector(
      ".react-flow__viewport",
    ) as HTMLElement | null;
  }, [flowContainerRef]);

  const downloadDataUrl = (dataUrl: string, filename: string) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.rel = "noopener";
    a.click();
  };

  const exportAs = useCallback(
    async (kind: "png" | "svg") => {
      const el = getViewportEl();
      if (!el || busy) return;
      setBusy(true);
      try {
        await fitView({ padding: 0.12, duration: 200 });
        await new Promise((r) => setTimeout(r, 230));
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);

        if (kind === "png") {
          const dataUrl = await toPng(el, {
            backgroundColor: "#f8fafc",
            pixelRatio: 2,
            cacheBust: true,
          });
          downloadDataUrl(dataUrl, `sitemap-graph-${stamp}.png`);
        } else {
          const dataUrl = await toSvg(el, {
            backgroundColor: "#f8fafc",
            cacheBust: true,
          });
          downloadDataUrl(dataUrl, `sitemap-graph-${stamp}.svg`);
        }
      } catch (e) {
        console.error("Graph export failed:", e);
      } finally {
        setBusy(false);
      }
    },
    [busy, fitView, getViewportEl],
  );

  const btnStyle: CSSProperties = {
    padding: "6px 10px",
    borderRadius: "8px",
    border: "1px solid #cbd5e1",
    background: busy ? "#e2e8f0" : "#ffffff",
    color: "#1e293b",
    fontSize: "12px",
    fontWeight: 600,
    cursor: busy ? "wait" : "pointer",
  };

  return (
    <Panel position="top-right">
      <div
        style={{
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: "11px", color: "#64748b", marginRight: "4px" }}>
          Export
        </span>
        <button
          type="button"
          disabled={busy}
          style={btnStyle}
          onClick={() => void exportAs("png")}
        >
          PNG
        </button>
        <button
          type="button"
          disabled={busy}
          style={btnStyle}
          onClick={() => void exportAs("svg")}
        >
          SVG
        </button>
      </div>
    </Panel>
  );
}

type InnerProps = {
  graphPages: GraphPage[];
  graphEdges: GraphEdge[];
  selectedPageNodeId: string | null;
  onSelectPageByNodeId: (nodeId: string) => void;
};

function SitemapGraphInner({
  graphPages,
  graphEdges,
  selectedPageNodeId,
  onSelectPageByNodeId,
}: InnerProps) {
  const flowContainerRef = useRef<HTMLDivElement>(null);

  const layouted = useMemo(
    () => pagesToFlowElements(graphPages, graphEdges, selectedPageNodeId),
    [graphPages, graphEdges, selectedPageNodeId],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layouted.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layouted.edges);

  useEffect(() => {
    setNodes(layouted.nodes);
    setEdges(layouted.edges);
  }, [layouted, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: ReactMouseEvent, node: Node) => {
      onSelectPageByNodeId(node.id);
    },
    [onSelectPageByNodeId],
  );

  if (graphPages.length === 0) {
    return (
      <div style={{ padding: "16px", color: "#64748b", fontSize: "14px" }}>
        No crawl pages to graph yet. Run <strong>Crawl</strong>, then open this tab
        again.
      </div>
    );
  }

  return (
    <div
      ref={flowContainerRef}
      style={{ width: "100%", height: "100%", minHeight: 360 }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        zoomOnScroll
        minZoom={0.15}
        maxZoom={1.5}
        fitView
      >
        <Background color="#e2e8f0" gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={2}
          zoomable
          pannable
          style={{ background: "#f8fafc" }}
        />
        <GraphExportToolbar flowContainerRef={flowContainerRef} />
        <FitViewOnChange nodeCount={nodes.length} />
      </ReactFlow>
    </div>
  );
}

export type SitemapGraphViewProps = {
  pages: GraphPage[];
  edges: GraphEdge[];
  selectedPageNodeId: string | null;
  onSelectPageByNodeId: (nodeId: string) => void;
};

/**
 * Site map graph: hierarchical (top-down) layout via Dagre inside React Flow.
 * Wraps with ReactFlowProvider so hooks work.
 */
export function SitemapGraphView({
  pages,
  edges,
  selectedPageNodeId,
  onSelectPageByNodeId,
}: SitemapGraphViewProps) {
  return (
    <div style={{ width: "100%", height: "100%", minHeight: 380 }}>
      <ReactFlowProvider>
        <SitemapGraphInner
          graphPages={pages}
          graphEdges={edges}
          selectedPageNodeId={selectedPageNodeId}
          onSelectPageByNodeId={onSelectPageByNodeId}
        />
      </ReactFlowProvider>
    </div>
  );
}
