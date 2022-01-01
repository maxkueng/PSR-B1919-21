#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const csv = require('fast-csv');
const DXF = require('dxf-writer');
const mkdirp = require('mkdirp');

/**
 * <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
 * START CONFIGURATION
 */

/**
 * Path to the OpenSCAD executable.
 */
const OPENSCAD_PATH = 'openscad';

/**
 * Path to the input dataset. Must be a CSV without column names.
 */
const INPUT = path.resolve('.', 'pulsar.csv');

/**
 * Path to the output directory.
 */
const OUTPUT_DIR = path.resolve('.', 'out');

/** 
 * Print layer height. This will be used to round the extrusion height of the
 * parts.
 */
const LAYER_HEIGHT = 0.2;

/**
 * Overall height in millimeter. This value will be rounded by LAYER_HEIGHT and
 * is used to calculate the extrusion height of the individual parts.
 */
const HEIGHT = 256;

/**
 * Overall width in millimeter.
 */
const WIDTH = 188;

/**
 * The relation between X and Y. Reduce this value to increase the height (Y
 * axis) of the dataset to get taller spikes in the graph.
 */
const X_Y_RELATION = 1.197;

/**
 * Some extra space at the bottom of the graph. This raises the Y axis to make
 * a thicker base.
 */
const PADDING_Y = 3;

/**
 * Available space of the print surface in the Y direction. This is used to
 * figure out how many parts to place on a print batch.
 */
const BED_Y = 200;

/**
 * END CONFIGURATION
 * >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
 **/




function createSTL(input, output, args = {}) {
  const params = Object.keys(args).reduce((acc, key) => [
    ...acc,
    '-D',
    `${key}=${JSON.stringify(args[key])}`
  ], []);

  return new Promise((resolve, reject) => {
    const cmd = spawn(
      OPENSCAD_PATH,
      [
        '-o',
        path.resolve(output),
        ...params,
        path.resolve(input),
      ],
    );

    cmd.stdout.on('data', (data) => {
      console.log(data.toString());
    });

    cmd.stderr.on('data', (data) => {
      console.log(data.toString());
    });

    cmd.on('error', (err) => {
      reject(err);
    });

    cmd.on('close', (code) => {
      resolve(code);
    });
  });
}

function round(value, decimals = 4) {
  const yolo = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * yolo) / yolo;
}

function ensureDir(dirPath) {
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path exists but is not a directory`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    return mkdirp.sync(dirPath);
  }
}

function getData(inputPath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(inputPath)
      .pipe(csv.parse({ headers: false }))
      .on('error', (err) => {
        reject(err);
      })
      .on('data', (row) => {
        rows.push(row.map((v) => round(Number(v))));
      })
      .on('end', () => {
        resolve(rows);
      });
  });
}

function getLowestValue(data) {
  if (Array.isArray(data[0])) {
    return getLowestValue(data.map(getLowestValue));
  }
  return data.reduce((l, d) => (
    Math.min(l, d)
  ), 0);
}

function getHighestValue(data) {
  if (Array.isArray(data[0])) {
    return getHighestValue(data.map(getHighestValue));
  }
  return data.reduce((l, d) => (
    Math.max(l, d)
  ), 0);
}

function createDXF(data, options) {
  const {
    scale,
    multiplierX,
    multiplierY,
    paddingY,
  } = options;
  const l = getLowestValue(data);
  const offsetY = l * -1;
  const dxf = new DXF();
  dxf.setUnits('Millimeters');

  const points = data.map((value, index) => [
    round((index * multiplierX * scale)),
    round(((value + offsetY) * multiplierY * scale) + paddingY),
  ]);
  const width = round(getHighestValue(points.map((p) => p[0])));
  const height = round(getHighestValue(points.map((p) => p[1])));

  dxf.drawPolyline([
    [0, 0],
    ...points,
    [round((data.length - 1) * multiplierX * scale), 0],
    [0, 0],
  ], true);

  return {
    width,
    height,
    dxf,
  };
}

function createDXFFiles({
  rows,
  dxfDirPath,
  multiplierX,
  paddingY,
  totalWidth,
}) {
  return rows.reverse().map((row, index) => {
    const {
      width,
      height,
      dxf,
    } = createDXF(row, {
      scale: totalWidth / ((rows[0].length -1) * multiplierX),
      multiplierX: multiplierX,
      multiplierY: 1,
      paddingY,
    });

    const fileName = `${String(index).padStart(2, '0')}.dxf`;
    fs.writeFileSync(path.join(dxfDirPath, fileName), dxf.toDxfString(), 'utf8');

    return {
      width,
      height,
      fileName,
    };
  });
}

function createPartSTLFiles({
  dxfFiles,
  dxfDirPath,
  stlDirPath,
  extrudeHeight,
}) {
  return Promise.all(dxfFiles.map(({ fileName }) => (
    createSTL(path.join('.', 'part.scad'), path.join(stlDirPath, `${path.basename(fileName)}.stl`), {
      dxf: path.join(dxfDirPath, fileName),
      height: extrudeHeight,
    })
  )));
}

function getBatchFileName(index, ext) {
  return `batch_${String(index).padStart(2, '0')}${ext}`;
}

function createBatchSCADFiles({
  dxfFiles,
  dxfDirPath,
  batchSCADDirPath,
  extrudeHeight,
  bedY,
}) {
  const partInitialOffsetY = 5;
  const partSpacingY = 2;
  const scadFiles = [];
  let partOffsetY = partInitialOffsetY;
  let scadCodeLines = [];

  dxfFiles.forEach(({ width, height, fileName}) => {
    const dxfFilePath = path.join(dxfDirPath, fileName);

    if (partOffsetY + partSpacingY + height > BED_Y) {
      scadFiles.push(scadCodeLines.join('\n'));
      scadCodeLines = [];
      partOffsetY = partInitialOffsetY;
    }

    partOffsetY += height + partSpacingY;

    scadCodeLines.push('rotate([180, 0, 0])');
    scadCodeLines.push(`translate([10, ${round(partOffsetY)*-1}, ${extrudeHeight * -1}])`);
    scadCodeLines.push(`linear_extrude(height = ${extrudeHeight})`);
    scadCodeLines.push(`import("${path.relative(batchSCADDirPath, dxfFilePath)}");`);
  });

  scadFiles.push(scadCodeLines.join('\n'));

  scadFiles.forEach((scadCode, index) => {
    const fileName = getBatchFileName(index, '.scad');
    fs.writeFileSync(path.join(batchSCADDirPath, fileName), scadCode, 'utf8');
  });

  return scadFiles;
}

function createBatchSTLFiles({
  batchSCADFiles,
  batchSCADDirPath,
  batchSTLDirPath,
}) {
  return Promise.all(batchSCADFiles.map((_, index) => {
    const scadFileName = getBatchFileName(index, '.scad');
    const stlFileName = getBatchFileName(index, '.stl');
    const scadFilePath = path.join(batchSCADDirPath, scadFileName);
    const stlFilePath = path.join(batchSTLDirPath, stlFileName);

    return createSTL(scadFilePath, stlFilePath);
  }));
}

async function run() {
  const dxfDirPath = path.join(OUTPUT_DIR, 'dxf');
  const stlDirPath = path.join(OUTPUT_DIR, 'stl');
  const batchSCADDirPath = path.join(OUTPUT_DIR, 'batch_scad');
  const batchSTLDirPath = path.join(OUTPUT_DIR, 'batch_stl');

  ensureDir(dxfDirPath);
  ensureDir(stlDirPath);
  ensureDir(batchSCADDirPath);
  ensureDir(batchSTLDirPath);

  const rows = await getData(INPUT);

  const dxfFiles = createDXFFiles({
    rows,
    dxfDirPath,
    multiplierX: X_Y_RELATION,
    totalWidth: WIDTH,
    paddingY: PADDING_Y,
  });

  const extrudeHeight = round(Math.floor(HEIGHT / rows.length / LAYER_HEIGHT) * LAYER_HEIGHT);

  await createPartSTLFiles({
    dxfFiles,
    dxfDirPath,
    stlDirPath,
    extrudeHeight,
  });

  const batchSCADFiles = createBatchSCADFiles({
    dxfFiles,
    dxfDirPath,
    batchSCADDirPath,
    extrudeHeight,
    bedY: BED_Y,
  });

  await createBatchSTLFiles({
    batchSCADFiles,
    batchSCADDirPath,
    batchSTLDirPath,
  });
}

run();

