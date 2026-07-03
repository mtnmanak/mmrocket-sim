/**
 * Desktop OpenRocket 24.12 built-in materials, extracted verbatim from
 * info.openrocket.core.database.Databases. Densities: BULK kg/m3,
 * SURFACE kg/m2, LINE kg/m. Names/values must track the desktop so .ork
 * files exchange cleanly.
 */

export interface MaterialDef {
  name: string;
  /** kg/m3 (bulk), kg/m2 (surface) or kg/m (line). */
  density: number;
  group: string;
}

export const BULK_MATERIALS: MaterialDef[] = [
  { name: 'Acrylic', density: 1190, group: 'PLASTICS' },
  { name: 'Aluminum', density: 2700, group: 'METALS' },
  { name: 'Balsa', density: 170, group: 'WOODS' },
  { name: 'Basswood', density: 500, group: 'WOODS' },
  { name: 'Birch', density: 670, group: 'WOODS' },
  { name: 'Brass', density: 8600, group: 'METALS' },
  { name: 'Cardboard', density: 680, group: 'PAPER' },
  { name: 'Carbon fiber', density: 1780, group: 'COMPOSITES' },
  { name: 'Cork', density: 240, group: 'WOODS' },
  { name: 'Delrin', density: 1420, group: 'PLASTICS' },
  { name: 'Depron (XPS)', density: 40, group: 'FOAMS' },
  { name: 'Fiberglass', density: 1850, group: 'COMPOSITES' },
  { name: 'Kraft phenolic', density: 950, group: 'COMPOSITES' },
  { name: 'Maple', density: 755, group: 'WOODS' },
  { name: 'Nylon', density: 1150, group: 'FIBERS' },
  { name: 'Paper (office)', density: 820, group: 'PAPER' },
  { name: 'Pine', density: 530, group: 'WOODS' },
  { name: 'Plywood (birch)', density: 630, group: 'WOODS' },
  { name: 'Polycarbonate (Lexan)', density: 1200, group: 'PLASTICS' },
  { name: 'Polystyrene', density: 1050, group: 'PLASTICS' },
  { name: 'PVC', density: 1390, group: 'PLASTICS' },
  { name: 'Spruce', density: 450, group: 'WOODS' },
  { name: 'Steel', density: 7850, group: 'METALS' },
  { name: 'Styrofoam (generic EPS)', density: 20, group: 'FOAMS' },
  { name: 'Titanium', density: 4500, group: 'METALS' },
  { name: 'Quantum tubing', density: 1050, group: 'PLASTICS' },
  { name: 'Blue tube', density: 1300, group: 'COMPOSITES' },
  { name: 'PLA - 100% infill', density: 1250, group: 'PLASTICS' },
  { name: 'PETG - 100% infill', density: 1250, group: 'PLASTICS' },
  { name: 'ABS - 100% infill', density: 1050, group: 'PLASTICS' },
];

export const SURFACE_MATERIALS: MaterialDef[] = [
  { name: 'Ripstop nylon', density: 0.067, group: 'FABRICS' },
  { name: 'Mylar', density: 0.021, group: 'PLASTICS' },
  { name: 'Polyethylene (thin)', density: 0.015, group: 'PLASTICS' },
  { name: 'Polyethylene (heavy)', density: 0.04, group: 'PLASTICS' },
  { name: 'Silk', density: 0.06, group: 'FABRICS' },
  { name: 'Paper (office)', density: 0.08, group: 'PAPER' },
  { name: 'Cellophane', density: 0.018, group: 'PLASTICS' },
  { name: 'Cr\u00eape paper', density: 0.025, group: 'PAPER' },
];

export const LINE_MATERIALS: MaterialDef[] = [
  { name: 'Thread (heavy-duty)', density: 0.0003, group: 'THREADS_LINES' },
  { name: 'Elastic cord (round 2 mm, 1/16 in)', density: 0.0018, group: 'THREADS_LINES' },
  { name: 'Elastic cord (flat 6 mm, 1/4 in)', density: 0.0043, group: 'THREADS_LINES' },
  { name: 'Elastic cord (flat 12 mm, 1/2 in)', density: 0.008, group: 'THREADS_LINES' },
  { name: 'Elastic cord (flat 19 mm, 3/4 in)', density: 0.0012, group: 'THREADS_LINES' },
  { name: 'Elastic cord (flat 25 mm, 1 in)', density: 0.0016, group: 'THREADS_LINES' },
  { name: 'Braided nylon (2 mm, 1/16 in)', density: 0.001, group: 'THREADS_LINES' },
  { name: 'Braided nylon (3 mm, 1/8 in)', density: 0.0035, group: 'THREADS_LINES' },
  { name: 'Tubular nylon (11 mm, 7/16 in)', density: 0.013, group: 'THREADS_LINES' },
  { name: 'Tubular nylon (14 mm, 9/16 in)', density: 0.016, group: 'THREADS_LINES' },
  { name: 'Tubular nylon (25 mm, 1 in)', density: 0.029, group: 'THREADS_LINES' },
  { name: 'Kevlar thread 138  (0.4 mm, 1/64 in)', density: 0.00014808, group: 'THREADS_LINES' },
  { name: 'Kevlar thread 207  (0.5 mm, 1/64 in)', density: 0.00023622, group: 'THREADS_LINES' },
  { name: 'Kevlar thread 346  (0.7 mm, 1/32 in)', density: 0.00047243, group: 'THREADS_LINES' },
  { name: 'Kevlar thread 415  (0.8 mm, 1/32 in)', density: 0.00055117, group: 'THREADS_LINES' },
  { name: 'Kevlar thread 800 (1.1 mm, 3/64 in)', density: 0.00099211, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (3.2 mm, 1/8 in)', density: 0.00967306, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (4.8 mm, 3/16 in)', density: 0.01785797, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (6.4 mm, 1/4 in)', density: 0.02976328, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (7.9 mm, 5/16 in)', density: 0.04464491, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (10 mm, 3/8 in)', density: 0.05952655, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (11 mm, 7/16 in)', density: 0.07440819, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (13 mm, 1/2 in)', density: 0.11607678, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (14 mm, 9/16 in)', density: 0.20834293, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (16 mm, 5/8 in)', density: 0.28721562, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (19 mm, 3/4 in)', density: 0.3497185, group: 'THREADS_LINES' },
  { name: 'Kevlar 12-strand (25 mm, 1 in)', density: 0.45686629, group: 'THREADS_LINES' },
  { name: 'Nylon flat webbing md. (10 mm, 3/8 in)', density: 0.00951444, group: 'THREADS_LINES' },
  { name: 'Nylon flat webbing md. (13 mm, 1/2  in)', density: 0.01334208, group: 'THREADS_LINES' },
  { name: 'Nylon flat webbing md. (16 mm, 5/8 in)', density: 0.01618548, group: 'THREADS_LINES' },
  { name: 'Nylon flat webbing lg. (14 mm, 9/16 in)', density: 0.02723097, group: 'THREADS_LINES' },
  { name: 'Nylon flat webbing lg. (25 mm, 1 in)', density: 0.03969816, group: 'THREADS_LINES' },
  { name: 'Paraline small IIIA (6.4 mm, 1.4 in)', density: 0.00371829, group: 'THREADS_LINES' },
  { name: 'Elastic rubber band (flat 3.2 mm, 1/8 in)', density: 0.00297638, group: 'THREADS_LINES' },
  { name: 'Elastic rubber band (flat 6.4 mm, 1/4 in)', density: 0.00613107, group: 'THREADS_LINES' },
  { name: 'Elastic braided cord (flat 3.2 mm, 1/8 in)', density: 0.00106, group: 'THREADS_LINES' },
  { name: 'Elastic braided cord (flat 4 mm, 5/32 in)', density: 0.002, group: 'THREADS_LINES' },
  { name: 'Elastic braided cord (flat 6.4 mm, 1/4 in)', density: 0.00254, group: 'THREADS_LINES' },
  { name: 'Elastic braided cord (round 2 mm, 1/16 in)', density: 0.0035, group: 'THREADS_LINES' },
  { name: 'Elastic braided cord (round 2.5 mm, 3/32 in)', density: 0.0038, group: 'THREADS_LINES' },
  { name: 'Elastic braided cord (flat 10 mm, 3/8 in)', density: 0.00381, group: 'THREADS_LINES' },
  { name: 'Elastic braided cord (flat 13 mm, 1/2 in)', density: 0.00551172, group: 'THREADS_LINES' },
];
