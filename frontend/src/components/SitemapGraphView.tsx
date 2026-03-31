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
  /** page | pdf | docx | … — drives node styling. */
  item_type?: string;
  /** When set, used with http_status to style “broken” nodes. */
  status_label?: string;
  http_status?: number;
};

export type GraphEdge = {
  source: string;
  target: string;
};

const NODE_W = 210;
const NODE_H = 68;

/** Visual bucket for palette + legend (not the same as item_type). */
export type NodeVariant =
  | "root"
  | "page"
  | "pdf"
  | "docx"
  | "epub"
  | "file"
  | "broken";

const VARIANT_STYLES: Record<
  NodeVariant,
  { bg: string; border: string; borderSelected: string; accent: string; label: string }
> = {
  root: {
    bg: "linear-gradient(145deg, #dbeafe 0%, #eff6ff 100%)",
    border: "#3b82f6",
    borderSelected: "#1d4ed8",
    accent: "#1e40af",
    label: "Root",
  },
  page: {
    bg: "linear-gradient(145deg, #f8fafc 0%, #ffffff 100%)",
    border: "#94a3b8",
    borderSelected: "#2563eb",
    accent: "#334155",
    label: "Web page",
  },
  pdf: {
    bg: "linear-gradient(145deg, #fee2e2 0%, #fff1f2 100%)",
    border: "#f87171",
    borderSelected: "#dc2626",
    accent: "#991b1b",
    label: "PDF",
  },
  docx: {
    bg: "linear-gradient(145deg, #dbeafe 0%, #eff6ff 100%)",
    border: "#60a5fa",
    borderSelected: "#2563eb",
    accent: "#1d4ed8",
    label: "DOCX",
  },
  epub: {
    bg: "linear-gradient(145deg, #ede9fe 0%, #f5f3ff 100%)",
    border: "#a78bfa",
    borderSelected: "#7c3aed",
    accent: "#5b21b6",
    label: "EPUB",
  },
  file: {
    bg: "linear-gradient(145deg, #f1f5f9 0%, #f8fafc 100%)",
    border: "#94a3b8",
    borderSelected: "#64748b",
    accent: "#475569",
    label: "File",
  },
  broken: {
    bg: "linear-gradient(145deg, #fef2f2 0%, #fff7ed 100%)",
    border: "#f97316",
    borderSelected: "#ea580c",
    accent: "#c2410c",
    label: "Broken / error",
  },
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function getNodeVariant(p: GraphPage): NodeVariant {
  if (p.category === "home") return "root";
  const code = p.http_status ?? 0;
  const label = (p.status_label ?? "").toLowerCase();
  const broken =
    label === "broken" ||
    label === "timeout_error" ||
    (code > 0 && code >= 400);
  if (broken) return "broken";
  const it = (p.item_type ?? "page").toLowerCase();
  if (it === "pdf") return "pdf";
  if (it === "docx") return "docx";
  if (it === "epub") return "epub";
  if (it === "file" || it === "doc") return "file";
  return "page";
}

function formatTooltipSecondLine(variant: NodeVariant, p: GraphPage): string {
  if (variant === "root") return "Type: Root page (start URL)";
  if (variant === "broken") {
    const code = p.http_status && p.http_status > 0 ? `HTTP ${p.http_status}` : "";
    const sl = p.status_label ? String(p.status_label) : "";
    return `Type: ${VARIANT_STYLES.broken.label}${code ? ` · ${code}` : ""}${sl ? ` · ${sl}` : ""}`;
  }
  const it = p.item_type ?? "page";
  return `Type: ${it === "page" ? "Web page" : it.toUpperCase()}`;
}

function buildNodeTooltip(p: GraphPage): string {
  const v = getNodeVariant(p);
  return `${p.url}\n${formatTooltipSecondLine(v, p)}`;
}

type SitemapNodeData = {
  title: string;
  url: string;
  category: string;
  item_type: string;
  variant: NodeVariant;
  selected: boolean;
  /** Precomputed: URL + type line for native tooltip */
  tooltip: string;
};

function SitemapNodeInner(props: NodeProps) {
  const data = props.data as SitemapNodeData;
  const st = VARIANT_STYLES[data.variant];

  return (
    <div
      title={data.tooltip}
      style={{
        padding: "10px 12px",
        borderRadius: "10px",
        background: st.bg,
        border: data.selected ? `2px solid ${st.borderSelected}` : `1px solid ${st.border}`,
        boxShadow: data.selected
          ? "0 4px 14px rgba(37, 99, 235, 0.2)"
          : "0 1px 3px rgba(15, 23, 42, 0.08)",
        minWidth: NODE_W - 8,
        maxWidth: NODE_W + 48,
        cursor: "grab",
        transition: "box-shadow 0.15s ease, border-color 0.15s ease",
      }}
    >
      <div
        style={{
          fontWeight: 700,
          fontSize: "12px",
          color: st.accent,
          lineHeight: 1.35,
          wordBreak: "break-word",
        }}
      >
        {truncate(data.title || data.url, 52)}
      </div>
      <div
        style={{
          fontSize: "10px",
          color: "#64748b",
          marginTop: "6px",
          fontWeight: 600,
          letterSpacing: "0.02em",
        }}
      >
        {VARIANT_STYLES[data.variant].label}
      </div>
    </div>
  );
}

const SitemapNode = memo(SitemapNodeInner);

const nodeTypes = { sitemap: SitemapNode } satisfies NodeTypes;

function layoutSignature(graphPages: GraphPage[], graphEdges: GraphEdge[]): string {
  const ids = graphPages.map((p) => p.nodeId).sort().join("\0");
  const es = graphEdges
    .map((e) => `${e.source}->${e.target}`)
    .sort()
    .join("\0");
  return `${ids}|${es}`;
}

/**
 * Dagre top-down layout; returns node center positions (for React Flow top-left).
 */
function computeDagrePositions(
  graphPages: GraphPage[],
  graphEdges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (graphPages.length === 0) return out;

  const idSet = new Set(graphPages.map((p) => p.nodeId));
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    align: "UL",
    nodesep: 56,
    ranksep: 80,
    marginx: 32,
    marginy: 32,
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

  for (const p of graphPages) {
    const pos = g.node(p.nodeId);
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      out.set(p.nodeId, { x: pos.x, y: pos.y });
    } else {
      out.set(p.nodeId, { x: 0, y: 0 });
    }
  }
  return out;
}

function buildNodesFromLayout(
  graphPages: GraphPage[],
  positions: Map<string, { x: number; y: number }>,
  selectedNodeId: string | null,
): Node[] {
  return graphPages.map((p) => {
    const pos = positions.get(p.nodeId) ?? { x: 0, y: 0 };
    const variant = getNodeVariant(p);
    return {
      id: p.nodeId,
      type: "sitemap",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: {
        title: p.title || p.url,
        url: p.url,
        category: p.category,
        item_type: p.item_type ?? "page",
        variant,
        selected: selectedNodeId === p.nodeId,
        tooltip: buildNodeTooltip(p),
      },
      draggable: true,
      selectable: true,
    };
  });
}

function buildEdges(graphPages: GraphPage[], graphEdges: GraphEdge[]): Edge[] {
  const idSet = new Set(graphPages.map((p) => p.nodeId));
  const seenEdge = new Set<string>();
  const edges: Edge[] = [];
  let ei = 0;
  for (const e of graphEdges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    const k = `${e.source}\t${e.target}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    edges.push({
      id: `e-${ei++}`,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      animated: false,
      style: { stroke: "#94a3b8", strokeWidth: 1.5 },
    });
  }
  return edges;
}

function FitViewOnChange({ layoutKey }: { layoutKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      fitView({ padding: 0.18, duration: 220 });
    });
    return () => cancelAnimationFrame(id);
  }, [layoutKey, fitView]);
  return null;
}

function GraphLegend() {
  const order: NodeVariant[] = ["root", "page", "pdf", "docx", "epub", "file", "broken"];
  return (
    <Panel position="bottom-left">
      <div
        style={{
          background: "rgba(255,255,255,0.96)",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "10px 12px",
          fontSize: "11px",
          color: "#334155",
          boxShadow: "0 4px 20px rgba(15,23,42,0.08)",
          maxWidth: 220,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: "8px", color: "#0f172a" }}>Legend</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {order.map((v) => {
            const s = VARIANT_STYLES[v];
            return (
              <div key={v} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    border: `2px solid ${s.border}`,
                    background: `linear-gradient(145deg, ${s.accent}22, ${s.accent}44)`,
                    flexShrink: 0,
                  }}
                />
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: "8px", fontSize: "10px", color: "#94a3b8", lineHeight: 1.4 }}>
          Hover a node for URL and type. Drag to rearrange; layout resets when the crawl graph
          changes.
        </div>
      </div>
    </Panel>
  );
}

/**
 * Export the graph viewport (nodes + edges only) as PNG or SVG using html-to-image.
 */
function GraphExportToolbar({
  flowContainerRef,
}: {
  flowContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const { fitView } = useReactFlow();
  const [busy, setBusy] = useState(false);

  const getViewportEl = useCallback(() => {
    return flowContainerRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
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
        <span style={{ fontSize: "11px", color: "#64748b", marginRight: "4px" }}>Export</span>
        <button type="button" disabled={busy} style={btnStyle} onClick={() => void exportAs("png")}>
          PNG
        </button>
        <button type="button" disabled={busy} style={btnStyle} onClick={() => void exportAs("svg")}>
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
  const selectedRef = useRef(selectedPageNodeId);
  selectedRef.current = selectedPageNodeId;

  const layoutKey = useMemo(
    () => layoutSignature(graphPages, graphEdges),
    [graphPages, graphEdges],
  );

  const positions = useMemo(
    () => computeDagrePositions(graphPages, graphEdges),
    [layoutKey, graphPages, graphEdges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Re-layout only when the crawl graph structure changes (preserves drag positions on selection).
  useEffect(() => {
    setNodes(buildNodesFromLayout(graphPages, positions, selectedRef.current));
    setEdges(buildEdges(graphPages, graphEdges));
  }, [layoutKey, graphPages, graphEdges, positions, setNodes, setEdges]);

  // Selection highlight only — does not reset Dagre positions.
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const d = n.data as SitemapNodeData;
        return {
          ...n,
          data: {
            ...d,
            selected: n.id === selectedPageNodeId,
            tooltip: d.tooltip,
          },
        };
      }),
    );
  }, [selectedPageNodeId, setNodes]);

  const onNodeClick = useCallback(
    (_: ReactMouseEvent, node: Node) => {
      onSelectPageByNodeId(node.id);
    },
    [onSelectPageByNodeId],
  );

  if (graphPages.length === 0) {
    return (
      <div style={{ padding: "16px", color: "#64748b", fontSize: "14px" }}>
        No crawl pages to graph yet. Run <strong>Crawl</strong>, then open this tab again.
      </div>
    );
  }

  return (
    <div
      ref={flowContainerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        flex: 1,
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        zoomOnScroll
        minZoom={0.12}
        maxZoom={1.6}
        fitView
      >
        <Background color="#e2e8f0" gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={2}
          zoomable
          pannable
          style={{ background: "#f8fafc" }}
          maskColor="rgba(15, 23, 42, 0.12)"
        />
        <GraphExportToolbar flowContainerRef={flowContainerRef} />
        <GraphLegend />
        <FitViewOnChange layoutKey={layoutKey} />
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
 * Site map graph: top-down Dagre layout, type-colored draggable nodes, legend, tooltips.
 */
export function SitemapGraphView({
  pages,
  edges,
  selectedPageNodeId,
  onSelectPageByNodeId,
}: SitemapGraphViewProps) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        minHeight: 360,
        flex: 1,
        display: "flex",
        flexDirection: "column",
      }}
    >
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

/** @deprecated Use layout from SitemapGraphView internals */
export function pagesToFlowElements(
  graphPages: GraphPage[],
  graphEdges: GraphEdge[],
  selectedNodeId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const positions = computeDagrePositions(graphPages, graphEdges);
  return {
    nodes: buildNodesFromLayout(graphPages, positions, selectedNodeId),
    edges: buildEdges(graphPages, graphEdges),
  };
}
