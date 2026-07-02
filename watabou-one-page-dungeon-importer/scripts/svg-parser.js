import { MODULE_ID } from "./constants.js";

const FLOOR_FILL = "#ff0000";
const DOOR_FILL = "#f7eede";
const DOOR_STROKE = "#000000";
const MAX_BACKGROUND_TEXTURE_SIZE = 4096;
const WATABOU_GRID_SIZE = 30;
const WALL_GRID_SUBDIVISIONS = 2;
const FALLBACK_SVG_GRID_SIZE = 72;
const EPSILON = 0.001;

export function buildWatabouSceneImport(svgText, options = {}) {
  const requestedGridSize = normalizePositiveNumber(options.gridSize, 72);
  const doc = parseSvgDocument(svgText);
  const root = doc.documentElement;

  const title = extractTitle(root);
  const sceneName = (options.sceneName?.trim() || title || "Watabou Dungeon").trim();
  const floorPaths = findFloorPaths(root);
  if (!floorPaths.length) throw new Error(game.i18n.localize("WatabouOPD.MissingFloor"));
  assertSupportedMapTransform(floorPaths);

  const rawFloorSubpaths = [];
  for (const path of floorPaths) {
    const transform = cumulativeTransform(path);
    const subpaths = parsePathSubpaths(path.getAttribute("d") ?? "");
    for (const subpath of subpaths) {
      if (subpath.length < 3) continue;
      rawFloorSubpaths.push(subpath.map((point) => applyMatrix(transform, point)));
    }
  }

  if (!rawFloorSubpaths.length) throw new Error(game.i18n.localize("WatabouOPD.MissingFloor"));

  const floorGeometry = classifyFloorSubpaths(rawFloorSubpaths);
  const floorSubpaths = floorGeometry.floors;
  const solidSubpaths = floorGeometry.solids;
  const wallCandidateSubpaths = floorSubpaths.concat(solidSubpaths);

  const svgGridSize = detectSvgGridSize(floorPaths, floorSubpaths) ?? FALLBACK_SVG_GRID_SIZE;
  const rawDoorLines = findDoorLines(root);
  const floorBounds = boundsFromPoints(wallCandidateSubpaths.flat());
  const floorGrid = buildCellGeometry(floorSubpaths, svgGridSize, WALL_GRID_SUBDIVISIONS, solidSubpaths);
  const secretPassages = findSecretPassagesFromNarrowPolygons(floorSubpaths, svgGridSize, floorGrid?.boundaryEdges ?? []);
  const secretDoorLines = secretPassages.doors;
  const secretOpeningLines = secretPassages.openings;
  const secretSideLines = secretPassages.sides;
  const doorLines = normalizeDoorLinesToGrid(rawDoorLines, floorBounds, svgGridSize)
    .filter((door) => !isNearExistingDoor(door, secretDoorLines, svgGridSize / 2));
  const contentBounds = boundsFromPoints([
    ...wallCandidateSubpaths.flat(),
    ...doorLines.flatMap((door) => [door.a, door.b]),
    ...secretDoorLines.flatMap((door) => [door.a, door.b]),
    ...secretOpeningLines.flatMap((door) => [door.a, door.b]),
    ...secretSideLines.flatMap((wall) => [wall.a, wall.b])
  ]);
  const crop = createGridAlignedCrop(contentBounds, floorBounds, svgGridSize);

  const gridSize = fitGridSizeToTextureLimit(requestedGridSize, svgGridSize, crop);
  const scale = gridSize / svgGridSize;
  const width = Math.ceil(crop.width * scale);
  const height = Math.ceil(crop.height * scale);
  const toScene = (point) => ({
    x: round((point.x - crop.x) * scale),
    y: round((point.y - crop.y) * scale)
  });

  const cellBoundaryEdges = floorGrid?.boundaryEdges ?? buildBoundaryEdges(wallCandidateSubpaths);
  const preciseBoundary = buildPreciseBoundaryEdges(
    wallCandidateSubpaths,
    cellBoundaryEdges,
    svgGridSize / WALL_GRID_SUBDIVISIONS,
    solidSubpaths
  );
  const boundaryEdges = replaceSteppedBoundaryEdges(
    cellBoundaryEdges,
    preciseBoundary.edges,
    preciseBoundary.maskEdges,
    svgGridSize / WALL_GRID_SUBDIVISIONS
  ).concat(buildConnectorBoundaryEdges(floorSubpaths, svgGridSize, svgGridSize / WALL_GRID_SUBDIVISIONS));
  const regularWalls = boundaryEdges.map((edge) => wallFromPoints(toScene(edge.a), toScene(edge.b)));
  const doorWalls = doorLines.map((door) => ({
    ...wallFromPoints(toScene(door.a), toScene(door.b)),
    door: globalThis.CONST?.WALL_DOOR_TYPES?.DOOR ?? 1,
    ds: globalThis.CONST?.WALL_DOOR_STATES?.CLOSED ?? 1,
    flags: {
      [MODULE_ID]: {
        source: "watabou-svg-door"
      }
    }
  }));
  const secretDoorWalls = secretDoorLines.map((door) => ({
    ...wallFromPoints(toScene(door.a), toScene(door.b)),
    door: globalThis.CONST?.WALL_DOOR_TYPES?.SECRET ?? 2,
    ds: globalThis.CONST?.WALL_DOOR_STATES?.CLOSED ?? 1,
    flags: {
      [MODULE_ID]: {
        source: "watabou-svg-secret-door"
      }
    }
  }));
  const allDoorWalls = doorWalls.concat(secretDoorWalls);
  const openingWalls = secretOpeningLines.map((opening) => wallFromPoints(toScene(opening.a), toScene(opening.b)));
  const secretSideWalls = secretSideLines.map((wall) => wallFromPoints(toScene(wall.a), toScene(wall.b)));
  const walls = subtractDoorOpenings(regularWalls, allDoorWalls.concat(openingWalls, secretSideWalls)).concat(secretSideWalls, allDoorWalls);

  return {
    sceneName,
    fileName: `${slugify(sceneName)}-${Date.now()}.svg`,
    croppedSvg: createCroppedSvg(root, crop, width, height),
    width,
    height,
    gridSize,
    requestedGridSize,
    svgGridSize,
    walls,
    stats: {
      floorPaths: floorPaths.length,
      doors: allDoorWalls.length,
      secretDoors: secretDoorWalls.length,
      walls: walls.length,
      svgGridSize,
      requestedGridSize
    }
  };
}

function parseSvgDocument(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement?.tagName?.toLowerCase() !== "svg") {
    throw new Error(game.i18n.localize("WatabouOPD.InvalidSvg"));
  }
  return doc;
}

function extractTitle(root) {
  const text = [...root.getElementsByTagName("text")]
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return text ?? "";
}

function findFloorPaths(root) {
  const clipPaths = [...root.getElementsByTagName("clipPath")];
  let best = [];
  for (const clipPath of clipPaths) {
    const paths = [...clipPath.getElementsByTagName("path")]
      .filter((path) => normalizeColor(path.getAttribute("fill")) === FLOOR_FILL);
    if (paths.length > best.length) best = paths;
  }
  return best;
}

function findDoorLines(root) {
  const paths = [...root.getElementsByTagName("path")].filter((path) => isDoorPath(path));

  const doors = [];
  for (const path of paths) {
    const points = extractPathNumberPairs(path.getAttribute("d") ?? "")
      .map((point) => applyMatrix(cumulativeTransform(path), point));
    if (points.length < 4) continue;

    const bounds = boundsFromPoints(points);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width < EPSILON || height < EPSILON) continue;

    if (width >= height) {
      const y = (bounds.minY + bounds.maxY) / 2;
      doors.push({ a: { x: bounds.minX, y }, b: { x: bounds.maxX, y } });
    } else {
      const x = (bounds.minX + bounds.maxX) / 2;
      doors.push({ a: { x, y: bounds.minY }, b: { x, y: bounds.maxY } });
    }
  }
  return dedupeLines(doors);
}

function isDoorPath(path) {
  const fill = normalizeColor(path.getAttribute("fill"));
  const stroke = normalizeColor(path.getAttribute("stroke"));
  const strokeWidth = Number.parseFloat(path.getAttribute("stroke-width") ?? "");
  if (fill === DOOR_FILL && stroke === DOOR_STROKE && Math.abs(strokeWidth - 3.5) < EPSILON) return true;
  return isDoorPathByGeometry(path, fill, stroke, strokeWidth);
}

function isDoorPathByGeometry(path, fill, stroke, strokeWidth) {
  if (!fill || fill === "none") return false;
  if (!stroke || stroke === "none") return false;
  if (!Number.isFinite(strokeWidth) || strokeWidth < 1 || strokeWidth > 4) return false;

  const points = extractPathNumberPairs(path.getAttribute("d") ?? "");
  if (points.length < 4) return false;

  const bounds = boundsFromPoints(points);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);

  if (shortSide < 6.2 || shortSide > 8.8) return false;
  if (longSide < 18 || longSide > 22.5) return false;

  return [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => isQuarterGridValue(value));
}

function isQuarterGridValue(value) {
  return Math.abs(value * 4 - Math.round(value * 4)) <= 0.04;
}

function assertSupportedMapTransform(floorPaths) {
  const matrix = cumulativeTransform(floorPaths[0]);
  if (isGridAxisAlignedTransform(matrix)) return;
  throw new Error(game.i18n.localize("WatabouOPD.UnsupportedRotatedMap"));
}

function isGridAxisAlignedTransform(matrix) {
  const scales = transformAxisScales(matrix);
  if (!scales) return false;
  if (Math.abs(scales.x - scales.y) > 0.01) return false;

  const xAxisHorizontal = Math.abs(matrix.b) <= EPSILON;
  const yAxisVertical = Math.abs(matrix.c) <= EPSILON;
  const xAxisVertical = Math.abs(matrix.a) <= EPSILON;
  const yAxisHorizontal = Math.abs(matrix.d) <= EPSILON;
  return (xAxisHorizontal && yAxisVertical) || (xAxisVertical && yAxisHorizontal);
}

function normalizeDoorLinesToGrid(doors, floorBounds, gridSize) {
  return dedupeLines(doors.map((door) => normalizeDoorLineToGrid(door, floorBounds, gridSize)));
}

function normalizeDoorLineToGrid(door, floorBounds, gridSize) {
  const width = Math.abs(door.b.x - door.a.x);
  const height = Math.abs(door.b.y - door.a.y);

  if (width >= height) {
    const [x1, x2] = snapDoorSpanToGrid(door.a.x, door.b.x, floorBounds.minX, gridSize);
    const y = (door.a.y + door.b.y) / 2;
    return { a: { x: x1, y }, b: { x: x2, y } };
  }

  const [y1, y2] = snapDoorSpanToGrid(door.a.y, door.b.y, floorBounds.minY, gridSize);
  const x = (door.a.x + door.b.x) / 2;
  return { a: { x, y: y1 }, b: { x, y: y2 } };
}

function snapDoorSpanToGrid(from, to, origin, gridSize) {
  const center = (from + to) / 2;
  const length = Math.abs(to - from);
  const cells = Math.max(1, Math.round(length / gridSize));
  const targetLength = cells * gridSize;
  const start = origin + Math.round((center - targetLength / 2 - origin) / gridSize) * gridSize;
  return [round(start), round(start + targetLength)];
}

function parsePathSubpaths(d) {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const subpaths = [];
  let index = 0;
  let command = "";
  let current = { x: 0, y: 0 };
  let start = null;
  let subpath = [];

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    if (upper === "M") {
      const point = readPoint(tokens, index, current, relative);
      current = point.value;
      start = current;
      subpath = [current];
      subpaths.push(subpath);
      index = point.index;
      command = relative ? "l" : "L";
      continue;
    }

    if (upper === "L") {
      const point = readPoint(tokens, index, current, relative);
      current = point.value;
      subpath.push(current);
      index = point.index;
      continue;
    }

    if (upper === "H") {
      const x = Number.parseFloat(tokens[index++]);
      current = { x: relative ? current.x + x : x, y: current.y };
      subpath.push(current);
      continue;
    }

    if (upper === "V") {
      const y = Number.parseFloat(tokens[index++]);
      current = { x: current.x, y: relative ? current.y + y : y };
      subpath.push(current);
      continue;
    }

    if (upper === "Z") {
      if (start) subpath.push(start);
      continue;
    }

    throw new Error(`Unsupported SVG path command: ${command}`);
  }

  return subpaths.map((points) => closePath(points)).filter((points) => points.length >= 4);
}

function readPoint(tokens, index, current, relative) {
  const x = Number.parseFloat(tokens[index]);
  const y = Number.parseFloat(tokens[index + 1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid SVG path coordinates.");
  const value = relative ? { x: current.x + x, y: current.y + y } : { x, y };
  return { value, index: index + 2 };
}

function closePath(points) {
  if (!points.length) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (samePoint(first, last)) return points;
  return [...points, first];
}

function buildBoundaryEdges(subpaths) {
  const horizontal = new Map();
  const vertical = new Map();

  for (const points of subpaths) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (samePoint(a, b)) continue;
      if (Math.abs(a.y - b.y) <= EPSILON) {
        addSegment(horizontal, quantize(a.y), quantize(a.x), quantize(b.x));
      } else if (Math.abs(a.x - b.x) <= EPSILON) {
        addSegment(vertical, quantize(a.x), quantize(a.y), quantize(b.y));
      }
    }
  }

  return [
    ...boundarySegments(horizontal, "h"),
    ...boundarySegments(vertical, "v")
  ];
}

function classifyFloorSubpaths(subpaths) {
  const floors = [];
  const solids = [];

  for (const polygon of subpaths) {
    const point = polygonRepresentativePoint(polygon);
    const depth = subpaths.filter((candidate) => candidate !== polygon && pointInPolygon(point, candidate)).length;
    if (depth % 2 === 0) floors.push(polygon);
    else solids.push(polygon);
  }

  return { floors, solids };
}

function polygonRepresentativePoint(polygon) {
  const bounds = boundsFromPoints(polygon);
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2
  };
}

function buildPreciseBoundaryEdges(subpaths, cellBoundaryEdges, tolerance, solidSubpaths = []) {
  const edges = [];
  const maskEdges = [];

  for (const polygon of subpaths) {
    if (!polygonHasNonAxisSegment(polygon)) continue;
    const solid = solidSubpaths.includes(polygon);

    for (let i = 0; i < polygon.length - 1; i += 1) {
      const a = polygon[i];
      const b = polygon[i + 1];
      if (samePoint(a, b)) continue;
      const edge = roundLine({ a, b });
      if (!isPreciseEdgeSupportedByCellBoundary(edge, cellBoundaryEdges, tolerance)) continue;
      maskEdges.push(edge);
      if (!solid && isPreciseEdgeConnectedToOtherFloor(edge, polygon, subpaths, tolerance)) continue;
      edges.push(edge);
    }
  }

  return {
    edges: dedupeLines(edges),
    maskEdges: dedupeLines(maskEdges)
  };
}

function isPreciseEdgeSupportedByCellBoundary(edge, cellBoundaryEdges, tolerance) {
  const midpoint = lineMidpoint(edge);
  return cellBoundaryEdges.some((cellEdge) => {
    if (distancePointToSegment(midpoint, cellEdge) <= tolerance) return true;
    return distancePointToSegment(lineMidpoint(cellEdge), edge) <= tolerance;
  });
}

function isPreciseEdgeConnectedToOtherFloor(edge, sourcePolygon, polygons, tolerance) {
  const edgeBounds = expandBounds(boundsFromPoints([edge.a, edge.b]), tolerance);
  return polygons.some((polygon) => {
    if (polygon === sourcePolygon) return false;
    if (!boundsOverlap(edgeBounds, boundsFromPoints(polygon))) return false;
    return distanceLineToPolygon(edge, polygon) <= tolerance;
  });
}

function distanceLineToPolygon(line, polygon) {
  let minDistance = Math.min(
    ...polygon.map((point) => distancePointToSegment(point, line)),
    distancePointToPolygon(lineMidpoint(line), polygon)
  );

  for (let i = 0; i < polygon.length - 1; i += 1) {
    const edge = { a: polygon[i], b: polygon[i + 1] };
    minDistance = Math.min(
      minDistance,
      distancePointToSegment(line.a, edge),
      distancePointToSegment(line.b, edge),
      distancePointToSegment(lineMidpoint(edge), line)
    );
  }

  return minDistance;
}

function distancePointToPolygon(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;

  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length - 1; i += 1) {
    minDistance = Math.min(minDistance, distancePointToSegment(point, { a: polygon[i], b: polygon[i + 1] }));
  }
  return minDistance;
}

function polygonHasNonAxisSegment(points) {
  for (let i = 0; i < points.length - 1; i += 1) {
    const line = { a: points[i], b: points[i + 1] };
    if (!isAxisAlignedLine(line) && lineLength(line) > EPSILON) return true;
  }
  return false;
}

function replaceSteppedBoundaryEdges(cellBoundaryEdges, preciseBoundaryEdges, maskEdges, tolerance) {
  if (!maskEdges.length) return cellBoundaryEdges;

  const filteredCellEdges = cellBoundaryEdges.filter((edge) => {
    const midpoint = lineMidpoint(edge);
    return !maskEdges.some((maskEdge) => distancePointToSegment(midpoint, maskEdge) <= tolerance);
  });

  return dedupeLines(filteredCellEdges.concat(preciseBoundaryEdges));
}

function buildConnectorBoundaryEdges(subpaths, cellSize, tolerance) {
  const edges = [];

  for (const polygon of subpaths) {
    if (!isSmallAxisAlignedPolygon(polygon, cellSize)) continue;

    for (let i = 0; i < polygon.length - 1; i += 1) {
      const edge = roundLine({ a: polygon[i], b: polygon[i + 1] });
      if (samePoint(edge.a, edge.b)) continue;
      if (isConnectorEdgeSharedWithOtherFloor(edge, polygon, subpaths, tolerance)) continue;
      edges.push(edge);
    }
  }

  return dedupeLines(edges);
}

function isSmallAxisAlignedPolygon(polygon, cellSize) {
  if (polygonHasNonAxisSegment(polygon)) return false;
  const bounds = boundsFromPoints(polygon);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return width <= cellSize * 1.25 && height <= cellSize * 1.25;
}

function isConnectorEdgeSharedWithOtherFloor(edge, sourcePolygon, polygons, tolerance) {
  const midpoint = lineMidpoint(edge);
  return polygons.some((polygon) => {
    if (polygon === sourcePolygon) return false;
    if (!boundsOverlap(expandBounds(boundsFromPoints([edge.a, edge.b]), tolerance), boundsFromPoints(polygon))) return false;
    return distancePointToPolygon(midpoint, polygon) <= tolerance * 0.25;
  });
}

function buildCellGeometry(subpaths, cellSize, subdivisions = 1, solidSubpaths = []) {
  if (!Number.isFinite(cellSize) || cellSize <= EPSILON) return null;
  const stepSize = cellSize / Math.max(1, Math.floor(subdivisions));

  const allPoints = subpaths.flat();
  const bounds = boundsFromPoints(allPoints);
  const origin = {
    x: round(bounds.minX),
    y: round(bounds.minY)
  };
  const occupied = new Set();

  for (const polygon of subpaths) {
    const polygonBounds = boundsFromPoints(polygon);
    const minColumn = Math.floor((polygonBounds.minX - origin.x) / stepSize - EPSILON);
    const maxColumn = Math.ceil((polygonBounds.maxX - origin.x) / stepSize + EPSILON) - 1;
    const minRow = Math.floor((polygonBounds.minY - origin.y) / stepSize - EPSILON);
    const maxRow = Math.ceil((polygonBounds.maxY - origin.y) / stepSize + EPSILON) - 1;

    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const center = {
          x: origin.x + (column + 0.5) * stepSize,
          y: origin.y + (row + 0.5) * stepSize
        };
        if (pointInPolygon(center, polygon)) occupied.add(cellKey(column, row));
      }
    }
  }

  for (const polygon of solidSubpaths) {
    const polygonBounds = boundsFromPoints(polygon);
    const minColumn = Math.floor((polygonBounds.minX - origin.x) / stepSize - EPSILON);
    const maxColumn = Math.ceil((polygonBounds.maxX - origin.x) / stepSize + EPSILON) - 1;
    const minRow = Math.floor((polygonBounds.minY - origin.y) / stepSize - EPSILON);
    const maxRow = Math.ceil((polygonBounds.maxY - origin.y) / stepSize + EPSILON) - 1;

    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const center = {
          x: origin.x + (column + 0.5) * stepSize,
          y: origin.y + (row + 0.5) * stepSize
        };
        if (pointInPolygon(center, polygon)) occupied.delete(cellKey(column, row));
      }
    }
  }

  if (!occupied.size) return null;

  const horizontal = new Map();
  const vertical = new Map();
  for (const key of occupied) {
    const [column, row] = key.split(":").map(Number);
    const x1 = round(origin.x + column * stepSize);
    const x2 = round(origin.x + (column + 1) * stepSize);
    const y1 = round(origin.y + row * stepSize);
    const y2 = round(origin.y + (row + 1) * stepSize);

    if (!occupied.has(cellKey(column, row - 1))) addSegment(horizontal, y1, x1, x2);
    if (!occupied.has(cellKey(column, row + 1))) addSegment(horizontal, y2, x1, x2);
    if (!occupied.has(cellKey(column - 1, row))) addSegment(vertical, x1, y1, y2);
    if (!occupied.has(cellKey(column + 1, row))) addSegment(vertical, x2, y1, y2);
  }

  return {
    boundaryEdges: [
      ...boundarySegments(horizontal, "h"),
      ...boundarySegments(vertical, "v")
    ],
    occupied,
    origin,
    stepSize
  };
}

function buildCellBoundaryEdges(subpaths, cellSize, subdivisions = 1) {
  return buildCellGeometry(subpaths, cellSize, subdivisions)?.boundaryEdges ?? null;
}

function findSecretPassagesFromNarrowPolygons(subpaths, cellSize, boundaryEdges) {
  const doors = [];
  const openings = [];
  const sides = [];
  for (const polygon of subpaths) {
    const bounds = boundsFromPoints(polygon);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (!isLikelySecretPassageBounds(width, height, cellSize)) continue;

    const horizontal = width > height;
    const probe = cellSize * 0.1;
    const lines = horizontal
      ? [
        {
          line: { a: { x: bounds.minX, y: bounds.minY }, b: { x: bounds.maxX, y: bounds.minY } },
          probe: { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY - probe },
          direction: { x: 0, y: -1 }
        },
        {
          line: { a: { x: bounds.minX, y: bounds.maxY }, b: { x: bounds.maxX, y: bounds.maxY } },
          probe: { x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY + probe },
          direction: { x: 0, y: 1 }
        }
      ]
      : [
        {
          line: { a: { x: bounds.minX, y: bounds.minY }, b: { x: bounds.minX, y: bounds.maxY } },
          probe: { x: bounds.minX - probe, y: (bounds.minY + bounds.maxY) / 2 },
          direction: { x: -1, y: 0 }
        },
        {
          line: { a: { x: bounds.maxX, y: bounds.minY }, b: { x: bounds.maxX, y: bounds.maxY } },
          probe: { x: bounds.maxX + probe, y: (bounds.minY + bounds.maxY) / 2 },
          direction: { x: 1, y: 0 }
        }
      ];

    const adjacentSides = lines
      .map((entry, index) => ({ ...entry, index }))
      .filter(({ probe }) => isPointInOtherPolygon(probe, polygon, subpaths));

    for (const { line, direction } of lines) {
      openings.push(roundLine(snapSecretDoorLineToBoundary(line, direction, boundaryEdges, cellSize, "nearest")));
    }

    if (adjacentSides.length === 1) {
      const openingEntry = adjacentSides[0];
      const doorEntry = lines[1 - openingEntry.index];
      const openingLine = roundLine(snapSecretDoorLineToBoundary(
        openingEntry.line,
        openingEntry.direction,
        boundaryEdges,
        cellSize,
        "nearest"
      ));
      const doorLine = roundLine(snapSecretDoorLineToBoundary(
        doorEntry.line,
        doorEntry.direction,
        boundaryEdges,
        cellSize,
        "farthest"
      ));

      openings.push(openingLine);
      doors.push(doorLine);
      sides.push(...secretPassageSideLines(openingLine, doorLine));
      continue;
    }

    for (const { line, direction } of adjacentSides) {
      doors.push(roundLine(snapSecretDoorLineToBoundary(line, direction, boundaryEdges, cellSize, "farthest")));
    }
  }
  return {
    doors: dedupeLines(doors),
    openings: dedupeLines(openings),
    sides: dedupeLines(sides)
  };
}

function secretPassageSideLines(openingLine, doorLine) {
  if (isHorizontalLine(openingLine) !== isHorizontalLine(doorLine)) return [];

  return [
    { a: { ...openingLine.a }, b: { ...doorLine.a } },
    { a: { ...openingLine.b }, b: { ...doorLine.b } }
  ].filter((line) => !samePoint(line.a, line.b));
}

function snapSecretDoorLineToBoundary(line, direction, boundaryEdges, cellSize, mode = "farthest") {
  const candidates = boundaryEdges
    .filter((edge) => isHorizontalLine(edge) === isHorizontalLine(line))
    .map((edge) => ({
      edge,
      distance: secretDoorBoundaryDistance(line, edge, direction),
      overlap: secretDoorBoundaryOverlap(line, edge)
    }))
    .filter((candidate) => candidate.distance >= -EPSILON && candidate.distance <= cellSize + EPSILON)
    .filter((candidate) => candidate.overlap >= lineLength(line) * 0.75);

  if (!candidates.length) return line;

  candidates.sort((a, b) => mode === "nearest" ? a.distance - b.distance : b.distance - a.distance);
  const edge = candidates[0].edge;
  if (isHorizontalLine(line)) {
    return { a: { x: line.a.x, y: edge.a.y }, b: { x: line.b.x, y: edge.a.y } };
  }
  return { a: { x: edge.a.x, y: line.a.y }, b: { x: edge.a.x, y: line.b.y } };
}

function secretDoorBoundaryDistance(line, edge, direction) {
  if (isHorizontalLine(line)) return (edge.a.y - line.a.y) * direction.y;
  return (edge.a.x - line.a.x) * direction.x;
}

function secretDoorBoundaryOverlap(line, edge) {
  if (isHorizontalLine(line)) {
    return rangeOverlapLength([line.a.x, line.b.x], [edge.a.x, edge.b.x]);
  }
  return rangeOverlapLength([line.a.y, line.b.y], [edge.a.y, edge.b.y]);
}

function lineLength(line) {
  return isHorizontalLine(line) ? Math.abs(line.b.x - line.a.x) : Math.abs(line.b.y - line.a.y);
}

function isLikelySecretPassageBounds(width, height, cellSize) {
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const halfCell = cellSize / 2;
  const shortMatches = Math.abs(shortSide - halfCell) <= cellSize * 0.18;
  const longMatches = longSide >= cellSize * 0.75 && longSide <= cellSize * 2.25;
  return shortMatches && longMatches;
}

function isPointInOtherPolygon(point, sourcePolygon, polygons) {
  return polygons.some((polygon) => polygon !== sourcePolygon && pointInPolygon(point, polygon));
}

function roundLine(line) {
  return {
    a: { x: round(line.a.x), y: round(line.a.y) },
    b: { x: round(line.b.x), y: round(line.b.y) }
  };
}

function findSecretDoorLines(grid, normalDoors) {
  const orientations = classifyNarrowCells(grid.occupied);
  const doors = [];

  for (const [key, orientation] of orientations.entries()) {
    const [column, row] = key.split(":").map(Number);

    if (orientation === "h") {
      collectSecretDoorAtNarrowEnd(doors, grid, normalDoors, orientations, column, row, -1, 0);
      collectSecretDoorAtNarrowEnd(doors, grid, normalDoors, orientations, column, row, 1, 0);
    } else if (orientation === "v") {
      collectSecretDoorAtNarrowEnd(doors, grid, normalDoors, orientations, column, row, 0, -1);
      collectSecretDoorAtNarrowEnd(doors, grid, normalDoors, orientations, column, row, 0, 1);
    }
  }

  return dedupeLines(doors);
}

function classifyNarrowCells(occupied) {
  const orientations = new Map();
  for (const key of occupied) {
    const [column, row] = key.split(":").map(Number);
    const left = occupied.has(cellKey(column - 1, row));
    const right = occupied.has(cellKey(column + 1, row));
    const up = occupied.has(cellKey(column, row - 1));
    const down = occupied.has(cellKey(column, row + 1));

    if ((left || right) && !up && !down) orientations.set(key, "h");
    else if ((up || down) && !left && !right) orientations.set(key, "v");
  }
  return orientations;
}

function collectSecretDoorAtNarrowEnd(doors, grid, normalDoors, orientations, column, row, dx, dy) {
  const orientation = orientations.get(cellKey(column, row));
  const sameDirectionKey = cellKey(column + dx, row + dy);
  if (orientations.get(sameDirectionKey) === orientation) return;
  if (!grid.occupied.has(sameDirectionKey)) return;

  const line = secretDoorLineForCellSide(grid, column, row, dx, dy);
  if (isNearExistingDoor(line, normalDoors, grid.stepSize)) return;
  doors.push(line);
}

function secretDoorLineForCellSide(grid, column, row, dx, dy) {
  const x1 = round(grid.origin.x + column * grid.stepSize);
  const x2 = round(grid.origin.x + (column + 1) * grid.stepSize);
  const y1 = round(grid.origin.y + row * grid.stepSize);
  const y2 = round(grid.origin.y + (row + 1) * grid.stepSize);

  if (dx < 0) return { a: { x: x1, y: y1 }, b: { x: x1, y: y2 } };
  if (dx > 0) return { a: { x: x2, y: y1 }, b: { x: x2, y: y2 } };
  if (dy < 0) return { a: { x: x1, y: y1 }, b: { x: x2, y: y1 } };
  return { a: { x: x1, y: y2 }, b: { x: x2, y: y2 } };
}

function isNearExistingDoor(line, doors, tolerance) {
  return doors.some((door) => {
    const sameOrientation = isHorizontalLine(line) === isHorizontalLine(door);
    if (!sameOrientation) return false;

    if (isHorizontalLine(line)) {
      const y = line.a.y;
      const doorY = door.a.y;
      if (Math.abs(y - doorY) > tolerance) return false;
      return rangesOverlap([line.a.x, line.b.x], [door.a.x, door.b.x], tolerance);
    }

    const x = line.a.x;
    const doorX = door.a.x;
    if (Math.abs(x - doorX) > tolerance) return false;
    return rangesOverlap([line.a.y, line.b.y], [door.a.y, door.b.y], tolerance);
  });
}

function isHorizontalLine(line) {
  return Math.abs(line.a.y - line.b.y) <= EPSILON;
}

function isVerticalLine(line) {
  return Math.abs(line.a.x - line.b.x) <= EPSILON;
}

function isAxisAlignedLine(line) {
  return isHorizontalLine(line) || isVerticalLine(line);
}

function lineMidpoint(line) {
  return pointOnSegment(line.a, line.b, 0.5);
}

function pointOnSegment(a, b, ratio) {
  return {
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio
  };
}

function distancePointToSegment(point, line) {
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - line.a.x, point.y - line.a.y);

  const ratio = Math.max(0, Math.min(1, ((point.x - line.a.x) * dx + (point.y - line.a.y) * dy) / lengthSquared));
  const closest = pointOnSegment(line.a, line.b, ratio);
  return Math.hypot(point.x - closest.x, point.y - closest.y);
}

function rangesOverlap(first, second, tolerance = 0) {
  const firstMin = Math.min(...first);
  const firstMax = Math.max(...first);
  const secondMin = Math.min(...second);
  const secondMax = Math.max(...second);
  return Math.max(firstMin, secondMin) <= Math.min(firstMax, secondMax) + tolerance;
}

function rangeOverlapLength(first, second) {
  const firstMin = Math.min(...first);
  const firstMax = Math.max(...first);
  const secondMin = Math.min(...second);
  const secondMax = Math.max(...second);
  return Math.max(0, Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const current = polygon[i];
    const previous = polygon[j];
    const intersects = ((current.y > point.y) !== (previous.y > point.y))
      && (point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function cellKey(column, row) {
  return `${column}:${row}`;
}

function detectSvgGridSize(floorPaths, subpaths) {
  return detectSvgGridSizeFromTransform(floorPaths) ?? detectSvgGridSizeFromDeltas(subpaths);
}

function detectSvgGridSizeFromTransform(floorPaths) {
  for (const path of floorPaths) {
    const matrix = cumulativeTransform(path);
    const scales = transformAxisScales(matrix);
    if (!scales) continue;
    if (Math.abs(scales.x - scales.y) > 0.01) continue;

    return round(WATABOU_GRID_SIZE * ((scales.x + scales.y) / 2));
  }
  return null;
}

function transformAxisScales(matrix) {
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const scaleY = Math.hypot(matrix.c, matrix.d);
  if (scaleX <= EPSILON || scaleY <= EPSILON) return null;
  return { x: scaleX, y: scaleY };
}

function detectSvgGridSizeFromDeltas(subpaths) {
  const xs = [];
  const ys = [];
  for (const point of subpaths.flat()) {
    xs.push(point.x);
    ys.push(point.y);
  }

  const candidates = [
    ...axisDeltas(xs),
    ...axisDeltas(ys)
  ].filter((delta) => delta > EPSILON);
  if (!candidates.length) return null;

  const counts = new Map();
  for (const delta of candidates) {
    const key = String(round(delta));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best = null;
  for (const [key, count] of counts.entries()) {
    const value = Number(key);
    if (!best || count > best.count || (count === best.count && value > best.value)) {
      best = { value, count };
    }
  }
  return best?.value ?? null;
}

function createGridAlignedCrop(bounds, floorBounds, gridSize) {
  const minX = floorBounds.minX + Math.floor((bounds.minX - floorBounds.minX) / gridSize) * gridSize - gridSize;
  const minY = floorBounds.minY + Math.floor((bounds.minY - floorBounds.minY) / gridSize) * gridSize - gridSize;
  const maxX = floorBounds.minX + Math.ceil((bounds.maxX - floorBounds.minX) / gridSize) * gridSize + gridSize;
  const maxY = floorBounds.minY + Math.ceil((bounds.maxY - floorBounds.minY) / gridSize) * gridSize + gridSize;

  return {
    x: round(minX),
    y: round(minY),
    width: round(maxX - minX),
    height: round(maxY - minY)
  };
}

function axisDeltas(values) {
  const unique = [...new Set(values.map((value) => round(value)))].sort((a, b) => a - b);
  const deltas = [];
  for (let i = 0; i < unique.length - 1; i += 1) {
    const delta = unique[i + 1] - unique[i];
    if (delta > EPSILON) deltas.push(delta);
  }
  return deltas;
}

function addSegment(lines, lineKey, from, to) {
  if (Math.abs(from - to) <= EPSILON) return;
  const line = lines.get(lineKey) ?? [];
  line.push({ from: Math.min(from, to), to: Math.max(from, to) });
  lines.set(lineKey, line);
}

function boundarySegments(lines, orientation) {
  const edges = [];

  for (const [lineKey, segments] of lines.entries()) {
    const cuts = [...new Set(segments.flatMap((segment) => [segment.from, segment.to]))].sort((a, b) => a - b);
    const counts = new Map();
    for (const segment of segments) {
      for (let i = 0; i < cuts.length - 1; i += 1) {
        const from = cuts[i];
        const to = cuts[i + 1];
        if (from + EPSILON < segment.from || to - EPSILON > segment.to) continue;
        const key = `${from}:${to}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    const elementary = [];
    for (const [key, count] of counts.entries()) {
      if (count % 2 === 0) continue;
      const [from, to] = key.split(":").map(Number);
      elementary.push({ from, to });
    }
    elementary.sort((a, b) => a.from - b.from);

    for (const segment of mergeSegments(elementary)) {
      if (orientation === "h") {
        edges.push({ a: { x: segment.from, y: lineKey }, b: { x: segment.to, y: lineKey } });
      } else {
        edges.push({ a: { x: lineKey, y: segment.from }, b: { x: lineKey, y: segment.to } });
      }
    }
  }

  return edges;
}

function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(previous.to - segment.from) <= EPSILON) {
      previous.to = segment.to;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function subtractDoorOpenings(walls, doors) {
  let result = walls;
  for (const door of doors) {
    result = result.flatMap((wall) => subtractDoorFromWall(wall, door));
  }
  return result;
}

function subtractDoorFromWall(wall, door) {
  const [x1, y1, x2, y2] = wall.c;
  const [dx1, dy1, dx2, dy2] = door.c;
  const horizontalWall = Math.abs(y1 - y2) <= EPSILON;
  const horizontalDoor = Math.abs(dy1 - dy2) <= EPSILON;
  const tolerance = 2;

  if (horizontalWall !== horizontalDoor) return [wall];
  if (horizontalWall && Math.abs(y1 - dy1) > tolerance) return [wall];
  if (!horizontalWall && Math.abs(x1 - dx1) > tolerance) return [wall];

  const wallFrom = horizontalWall ? Math.min(x1, x2) : Math.min(y1, y2);
  const wallTo = horizontalWall ? Math.max(x1, x2) : Math.max(y1, y2);
  const doorFrom = horizontalWall ? Math.min(dx1, dx2) : Math.min(dy1, dy2);
  const doorTo = horizontalWall ? Math.max(dx1, dx2) : Math.max(dy1, dy2);
  const overlapFrom = Math.max(wallFrom, doorFrom);
  const overlapTo = Math.min(wallTo, doorTo);
  if (overlapTo - overlapFrom <= tolerance) return [wall];

  const pieces = [];
  if (overlapFrom - wallFrom > tolerance) pieces.push(makeWallPiece(wall, wallFrom, overlapFrom, horizontalWall));
  if (wallTo - overlapTo > tolerance) pieces.push(makeWallPiece(wall, overlapTo, wallTo, horizontalWall));
  return pieces;
}

function makeWallPiece(wall, from, to, horizontal) {
  const [x1, y1] = wall.c;
  return horizontal
    ? { ...wall, c: [round(from), y1, round(to), y1] }
    : { ...wall, c: [x1, round(from), x1, round(to)] };
}

function wallFromPoints(a, b) {
  return {
    c: [round(a.x), round(a.y), round(b.x), round(b.y)]
  };
}

function createCroppedSvg(root, crop, width, height) {
  const clone = root.cloneNode(true);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `${round(crop.x)} ${round(crop.y)} ${round(crop.width)} ${round(crop.height)}`);
  clone.setAttribute("preserveAspectRatio", "none");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

function fitGridSizeToTextureLimit(requestedGridSize, svgGridSize, crop) {
  const maxSceneScale = Math.min(
    MAX_BACKGROUND_TEXTURE_SIZE / crop.width,
    MAX_BACKGROUND_TEXTURE_SIZE / crop.height
  );
  const maxGridSize = Math.max(1, Math.floor(maxSceneScale * svgGridSize));
  return Math.max(1, Math.min(Math.floor(requestedGridSize), maxGridSize));
}

function cumulativeTransform(element) {
  const chain = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (current.hasAttribute("transform")) chain.unshift(parseTransform(current.getAttribute("transform")));
    current = current.parentNode;
  }
  return chain.reduce((matrix, next) => multiplyMatrices(matrix, next), identityMatrix());
}

function parseTransform(transform) {
  let matrix = identityMatrix();
  const matches = transform.matchAll(/([a-zA-Z]+)\(([^)]*)\)/g);
  for (const match of matches) {
    const name = match[1].toLowerCase();
    const values = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let next = identityMatrix();
    if (name === "matrix" && values.length >= 6) {
      next = { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
    } else if (name === "translate") {
      next = { ...identityMatrix(), e: values[0] ?? 0, f: values[1] ?? 0 };
    } else if (name === "scale") {
      next = { ...identityMatrix(), a: values[0] ?? 1, d: values[1] ?? values[0] ?? 1 };
    } else if (name === "rotate") {
      const angle = ((values[0] ?? 0) * Math.PI) / 180;
      const rotation = { a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: 0, f: 0 };
      if (values.length >= 3) {
        const [cx, cy] = [values[1], values[2]];
        next = multiplyMatrices(
          multiplyMatrices({ ...identityMatrix(), e: cx, f: cy }, rotation),
          { ...identityMatrix(), e: -cx, f: -cy }
        );
      } else {
        next = rotation;
      }
    }
    matrix = multiplyMatrices(matrix, next);
  }
  return matrix;
}

function multiplyMatrices(first, second) {
  return {
    a: first.a * second.a + first.c * second.b,
    b: first.b * second.a + first.d * second.b,
    c: first.a * second.c + first.c * second.d,
    d: first.b * second.c + first.d * second.d,
    e: first.a * second.e + first.c * second.f + first.e,
    f: first.b * second.e + first.d * second.f + first.f
  };
}

function applyMatrix(matrix, point) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function extractPathNumberPairs(d) {
  const numbers = d.match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  const points = [];
  for (let i = 0; i < numbers.length - 1; i += 2) {
    points.push({ x: numbers[i], y: numbers[i + 1] });
  }
  return points;
}

function boundsFromPoints(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

function expandBounds(bounds, amount) {
  return {
    minX: bounds.minX - amount,
    maxX: bounds.maxX + amount,
    minY: bounds.minY - amount,
    maxY: bounds.maxY + amount
  };
}

function boundsOverlap(first, second) {
  return first.minX <= second.maxX + EPSILON
    && first.maxX + EPSILON >= second.minX
    && first.minY <= second.maxY + EPSILON
    && first.maxY + EPSILON >= second.minY;
}

function dedupeLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const forward = `${quantize(line.a.x)}:${quantize(line.a.y)}:${quantize(line.b.x)}:${quantize(line.b.y)}`;
    const backward = `${quantize(line.b.x)}:${quantize(line.b.y)}:${quantize(line.a.x)}:${quantize(line.a.y)}`;
    const key = forward < backward ? forward : backward;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeColor(value) {
  return (value ?? "").trim().toLowerCase();
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isCommand(token) {
  return /^[a-zA-Z]$/.test(token);
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function quantize(value) {
  return Math.round(value / EPSILON) * EPSILON;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function slugify(value) {
  const slug = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || "watabou-dungeon";
}
