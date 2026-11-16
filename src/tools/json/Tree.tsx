import { memo, useState } from 'react';
import { pathSegment, type JsonNode } from './json';

const PAGE = 100; // children shown per "show more"

interface Props {
  node: JsonNode;
  label: string | number | null; // key, index, or null for the root
  path: string;
  depth: number;
  openDepth: number; // nodes shallower than this start open
  selected: string | null;
  onSelect: (path: string, node: JsonNode) => void;
}

function summary(n: JsonNode) {
  if (n.type === 'object') return `{ ${n.entries.length} ${n.entries.length === 1 ? 'key' : 'keys'} }`;
  if (n.type === 'array') return `[ ${n.items.length} ${n.items.length === 1 ? 'item' : 'items'} ]`;
  return '';
}

function Leaf({ n }: { n: JsonNode }) {
  switch (n.type) {
    case 'string':
      return <span className="jt-s">{JSON.stringify(n.value)}</span>;
    case 'number':
      return <span className="jt-n">{n.raw}</span>;
    case 'boolean':
      return <span className="jt-b">{String(n.value)}</span>;
    case 'null':
      return <span className="jt-z">null</span>;
    default:
      return null;
  }
}

function TreeNodeImpl({ node, label, path, depth, openDepth, selected, onSelect }: Props) {
  const container = node.type === 'object' || node.type === 'array';
  const [open, setOpen] = useState(depth < openDepth);
  const [shown, setShown] = useState(PAGE);
  const count = node.type === 'object' ? node.entries.length : node.type === 'array' ? node.items.length : 0;

  const name =
    label === null ? (
      <span className="jt-tree-root mono">$</span>
    ) : typeof label === 'number' ? (
      <span className="jt-tree-idx">{label}</span>
    ) : (
      <span className="jt-k">{label}</span>
    );

  return (
    <li role="treeitem" aria-expanded={container && count ? open : undefined} aria-selected={selected === path}>
      <div className={`jt-tree-row${selected === path ? ' is-selected' : ''}`} style={{ paddingLeft: depth * 16 + 4 }}>
        {container && count ? (
          <button
            type="button"
            className={`jt-tree-toggle${open ? ' is-open' : ''}`}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => setOpen((o) => !o)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span className="jt-tree-toggle" aria-hidden="true" />
        )}
        <button
          type="button"
          className="jt-tree-label"
          onClick={() => onSelect(path, node)}
          onDoubleClick={() => container && count && setOpen((o) => !o)}
        >
          {name}
          <span className="jt-p">: </span>
          {container ? <span className="jt-tree-sum">{summary(node)}</span> : <Leaf n={node} />}
        </button>
      </div>
      {container && open && count > 0 && (
        <ul role="group">
          {node.type === 'object'
            ? node.entries.slice(0, shown).map((e, k) => (
                <TreeNode
                  key={k}
                  node={e.value}
                  label={e.key}
                  path={path + pathSegment(e.key)}
                  depth={depth + 1}
                  openDepth={openDepth}
                  selected={selected}
                  onSelect={onSelect}
                />
              ))
            : node.type === 'array' &&
              node.items.slice(0, shown).map((v, k) => (
                <TreeNode
                  key={k}
                  node={v}
                  label={k}
                  path={path + pathSegment(k)}
                  depth={depth + 1}
                  openDepth={openDepth}
                  selected={selected}
                  onSelect={onSelect}
                />
              ))}
          {count > shown && (
            <li style={{ paddingLeft: (depth + 1) * 16 + 28 }}>
              <button type="button" className="jt-tree-more mono" onClick={() => setShown((s) => s + PAGE * 5)}>
                show {Math.min(PAGE * 5, count - shown)} more of {count - shown}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

const TreeNode = memo(TreeNodeImpl);

export default function Tree(props: { root: JsonNode; openDepth: number; selected: string | null; onSelect: (path: string, node: JsonNode) => void }) {
  return (
    <ul className="jt-tree mono" role="tree" aria-label="JSON tree">
      <TreeNode node={props.root} label={null} path="$" depth={0} openDepth={props.openDepth} selected={props.selected} onSelect={props.onSelect} />
    </ul>
  );
}
