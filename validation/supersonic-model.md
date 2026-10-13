# The Supersonic aerodynamic model implemented in the app

Source snapshot: `c8faea2d1a267b095024fe780bbc8efdf5e8612f`, inspected 2026-10-13.
This describes MMRocket Sim's implementation, including its subsonic branches. The
app uses the OpenRocket 24.12 Java core, with the patches identified below,
compiled to JavaScript by TeaVM. It is a separate application, not an OpenRocket
release. Source is distributed under GPL-3.0-or-later; see [LICENSE](../LICENSE).

The model is a component build-up of normal force, moments and drag. It is not a
second-order shock-expansion (SOSE) solver, a Taylor-Maccoll solver, a CFD solver,
or a reproduction of unpublished RASAero equations. Analytic theory, desktop
OpenRocket correlations, empirical tables and fitted corrections coexist. A
calculation continuing to a Mach number does not establish physical accuracy
there. The validation section separates measurements from program verification.

## Reading the equations

All lengths are metres, areas square metres, volumes cubic metres, velocities
metres per second, pressure pascals, and angles radians. Mach, Reynolds number,
drag coefficients and interference multipliers are dimensionless. `CNa` is the
kernel's normal-force weight, in inverse radians; at finite angle it can be a
secant coefficient rather than a mathematical derivative. Positions increase aft
from the nose. Component formulas initially use the component's local origin.

Source abbreviations below are literal repository paths; `BC:159`, for example,
means `engine-java/patches/info/openrocket/core/aerodynamics/BarrowmanCalculator.java:159`.
Line numbers refer to this snapshot. The source links open the corresponding file.

| Key | Source |
|---|---|
| BC | [BarrowmanCalculator.java](../engine-java/patches/info/openrocket/core/aerodynamics/BarrowmanCalculator.java) |
| SC | [SymmetricComponentCalc.java](../engine-java/patches/info/openrocket/core/aerodynamics/barrowman/SymmetricComponentCalc.java) |
| FC | [FinSetCalc.java](../engine-java/patches/info/openrocket/core/aerodynamics/barrowman/FinSetCalc.java) |
| RC | [RocketComponentCalc.java](../engine-java/patches/info/openrocket/core/aerodynamics/barrowman/RocketComponentCalc.java) |
| AC | [AbstractAerodynamicCalculator.java](../engine-java/patches/info/openrocket/core/aerodynamics/AbstractAerodynamicCalculator.java) |
| AF | [AerodynamicForces.java](../engine-java/patches/info/openrocket/core/aerodynamics/AerodynamicForces.java) |
| FL | [FlightConditions.java](../engine-java/patches/info/openrocket/core/aerodynamics/FlightConditions.java) |
| TF | [TubeFinSetCalc.java](../engine-java/patches/info/openrocket/core/aerodynamics/barrowman/TubeFinSetCalc.java) |
| RK | [RK4SimulationStepper.java](../engine-java/patches/info/openrocket/core/simulation/RK4SimulationStepper.java) |
| API | [OrkEngine.java](../engine-java/src/api/java/api/OrkEngine.java) |

`clip(x,a,b)` clamps x to [a,b]; `S(t)=t*t*(3-2*t)` is smoothstep on [0,1].
`sqrtSafe(x)` denotes the kernel's square root of `max(x,0)`. Unless stated
otherwise, interpolation between stored points is linear and values outside the
stored range clamp to the nearest endpoint. This matters: an analytic expression
used to construct a sampled curve is not evaluated afresh inside that curve.
The kernel numerical epsilon is 1e-8 (desktop `MathUtil.java:16`); the surface
roughness epsilon in E36/E43 is a different quantity with units of metres.

### E01 — normalization and Prandtl factors

```text
Aref = pi*(dref/2)^2
q = rho*V^2/2
Daxial = q*Aref*CDaxial
betaConditions = max(0.25, sqrt(abs(1-M^2)))
betaSupersonic = sqrt(M^2-1)                  (M > 1)
alpha = clip(alphaInput,0,pi)
sinAlpha = alpha if alpha < .001; otherwise sin(alpha)
sinc(alpha) = 1 if alpha < .001; otherwise sinAlpha/alpha
```

Source: desktop OR, `FL:113`, `FL:163`, `FL:306`, `RK:612`.
`dref` is the configuration's reference length, normally a body diameter, not
total rocket length. Analytic fin and nose extensions use `betaSupersonic`
without the 0.25 floor; fin CP and desktop roll damping use `betaConditions`.
`rho` is atmospheric density (kg/m^3).
The overload accepting an already computed sine uses `clip(sineInput,0,1)`
instead of recomputing sinAlpha, with the same .001-rad sinc threshold
(`FL:187`). This small-angle convention also enters E03/E04.

## Model selection and Hybrid

Selecting Supersonic enables `supersonicAero` for the entire calculation, including
the low-speed parts of a flight. Rogers Kbf is a different endpoint, with
`rogersKbf=true` and `supersonicAero=false`. The ordinary Supersonic selection can
leave `rogersKbf=false`: the shared optional drag terms test either flag, and its
normal-force law explicitly suppresses the separate Kbf carryover. Hybrid builds
two permanent calculators: Kbf `(true,false)` and Supersonic `(true,true)`.
The bridge chooses the calculator for static analysis, drag sweeps and flight
(`API:552`; flag propagation `BC:1817`, `BC:1829`).

### E02 — Hybrid force and CP blending

```text
t = clip((M-Mlow)/(Mhigh-Mlow), 0, 1)
w = S(t)
Fhybrid = (1-w)*Fkbf + w*Fsupersonic
Wh = (1-w)*Wk + w*Ws
rh = ((1-w)*Wk*rk + w*Ws*rs)/Wh
```

Source: app interpolation construction, `BC:159`, `BC:168`, `BC:177`.
Here F denotes each completed coefficient, including drag components, axial
drag, moments and reported damping fields; r is the derivative CP vector (m),
and W its CNa weight. A weight numerically equal to zero returns the zero
coordinate. Endpoint objects are returned directly at w=0 or w=1. Default band:
Mach 0.8–1.2 (`BC:59`, `API:1257`); custom endpoints must be finite with
`0 <= Mlow < Mhigh` (`BC:131`). Final endpoint moments already include damping,
so Hybrid does not subtract it a second time. Above 20 degrees, reported CP is
instead computed from the blended zero-rate CN and normal Cm using E29.
The blend is an experiment, not a measured improvement over either endpoint.

## Nose, body tube and transition normal forces

Let L, r0 and r1 be component length and fore/aft radii; A0 and A1 its end
areas; Vf its full external volume; Ap its side planform area, and xp its
planform centroid. A nose for the growth rule means the component's fore radius
is below 1e-9 m and aft radius is larger (`SC:115`). A zero-length symmetric
component uses its larger radius at both ends (`SC:99`).

### E03 — slender-body force and CP

```text
A0 = pi*r0^2; A1 = pi*r1^2
CNaSlender = 2*(A1-A0)/Aref
xSlender = (L*A1-Vf)/(A1-A0)
G(M) = 1                           (M <= 1, or not a nose)
G(M) = 1 + g*(min(M,5)-1)           (nose, M > 1)
Wslender = CNaSlender*G(M)*sinc(alpha)
g = 0.10 for CONICAL; 0.07 for every other nose shape
```

Source: desktop OR/Barrowman for the area and volume law, `SC:155`; app fit for
Mach growth, `SC:180`. The growth is a calibrated surrogate, not a solved cone
pressure field; [LEDGER](../engine-java/patches/LEDGER.md) Phase 1 names NASA
SP-3004 and ARCAS/Basic Finner as its motivation. No paper equation establishes
these two growth constants. Equal end radii give zero slender load and no
slender CP. Transitions, boattails and flares retain the slender law at all Mach.
The nose's own slender CP does not move with Mach.

### E04 — Galejs body lift and component moment

```text
h = (M/0.05)^2   if M < 0.05 and alpha > pi/4; otherwise h = 1
Wlift = h*1.1*(Ap/Aref)*sinAlpha*sinc(alpha)
W = Wslender + Wlift
xCP = (Wslender*xSlender + Wlift*xp)/W
CN = W*alpha
Cm = CN*xCP/dref
```

Source: desktop OR/Galejs extension, `SC:188`, `SC:215`.
A tube has only the lift term at xp. For other symmetric components with
abs(W)<epsilon^2, the coordinate average instead uses (xSlender+xp)/2 with weight zero (desktop
`Coordinate.java:295`); the displayed quotient is for other weights. The
constant 1.1 is a body crossflow approximation, with an artificial low-Mach,
high-angle suppression around apogee. Jorgensen's Mach-dependent cylinder drag,
finite-length factor and high-angle potential-flow shaping are not implemented.
These symmetric components set side, yaw and roll coefficients to zero locally.

## Nose and expanding-transition pressure drag

Define component fineness `f=L/(2*abs(r1-r0))`, projected area difference
`Af=pi*abs(r1^2-r0^2)`, and shape parameter p. The implementation estimates
the aft-profile slope from the last 1% of length (`SC:105`, `SC:128`):

### E05 — slope and local coefficient scaling

```text
sinPhi = (r1-r(0.99*L))/hypot(r1-r(0.99*L), 0.01*L)
CDpressure = c(M)*Af/Aref
```

Source: desktop OR, `SC:128`, `SC:408`. Body tubes/equal radii return zero
pressure drag. For L < 0.001 m an expanding component uses stagnation drag E13;
a contracting one uses base drag E15, both on Af/Aref (`SC:274`). These simple
cases return before the interpolators or supersonic boattail treatment.

### E06 — conical and non-Fleeman ogive curve

```text
u = 0.72*(p-0.5)^2 + 0.82; p = 0 for a cone
c1 = sinPhi
c13 = 2.1*sinPhi^2 + 0.6019*sinPhi
d1 = 4/(gamma+1)*(1-0.5*c1)
d13 = -1.1341*sinPhi
c(M) = u*H(M; 1,1.3,c1,c13,d1,d13)     sampled 1 to 1.3, step 0.02
c(M) = u*(2.1*sinPhi^2+0.5*sinPhi/sqrt(M^2-1))
                                            sampled 1.32 to <4, step 0.02
```

Source: desktop OR correlation, `SC:846`, `SC:849`; gamma=1.4. H is the
unique cubic Hermite polynomial specified by endpoint values and Mach slopes.
For endpoints a,b, t=(M-a)/(b-a), it is
`(2t^3-3t^2+1)*ca + (t^3-2t^2+t)*(b-a)*da
 + (-2t^3+3t^2)*cb + (t^3-t^2)*(b-a)*db`.
The August target spec calls this fourth order; the four constraints actually
define a cubic. Cones and ogives with p<0.35 take this curve. Non-nose expanding
ogives also take it regardless of p. Stored samples are subsequently linearly
interpolated, with subsonic construction E10.

### E07 — Fleeman ogive curve and sonic bridge

```text
fn = L/(2*r1)
N = atan(0.5/fn)^1.69 * (0.72*(p-0.5)^2+0.82)
c13 = (1.59+1.83/1.3^2)*N
c1 = 0.30*c13
d1 = min(4/(gamma+1)*(1-0.5*c1), 2*(c13-c1)/0.3)
d13 = -2*1.83*N/1.3^3
c(M) = H(M; 1,1.3,c1,c13,d1,d13)    sampled 1 to 1.3, step 0.02
c(M) = (1.59+1.83/M^2)*N             beyond the last bridge sample
```

Source: Fleeman/Bonney empirical correlation plus app fit, `SC:596`, `SC:897`,
`SC:366`. Fleeman's *Maximizing Missile Flight Performance*, 2009 course,
slide 5 is the printed correlation identified in the ledger (no equation number);
the shape multiplier, 0.30 sonic ratio, slope cap and interpolation are the
implementation's construction. Applies only to actual OGIVE noses with p>=0.35,
under Supersonic or Kbf. E10 builds its subsonic tail too. The book's correlation
is not evidence for the sonic bridge or subsonic extension. Stubby noses and
very high Mach extrapolate beyond its supported shape/regime assumptions.

### E08 — stored nose tables

The following are the executable coefficient samples at fineness 3. Source:
desktop OR's transcription of NASA TR R-100 p.16, `SC:498`. This table records
the code values; it is not a fresh digitization of that report.

| Shape | (Mach, local c) samples |
|---|---|
| Ellipsoid | (1.2,.110), (1.25,.128), (1.3,.140), (1.4,.148), (1.6,.152), (2,.159), (2.4,.162) |
| Power 1/4 | (1.2,.140), (1.3,.156), (1.4,.169), (1.6,.192), (1.8,.206), (2.2,.227), (2.6,.241), (3,.249), (3.6,.252) |
| Power 1/2 | (.925,0), (.95,.014), (1,.050), (1.05,.060), (1.1,.059), (1.2,.081), (1.3,.084), (1.7,.085), (2,.078) |
| Power 3/4 | (.8,0), (.9,.015), (1,.078), (1.06,.121), (1.2,.110), (1.4,.098), (1.6,.090), (2,.084), (2.8,.078), (3.4,.074) |
| Von Karman | (.9,0), (.95,.010), (1,.027), (1.05,.055), (1.1,.070), (1.2,.081), (1.4,.095), (1.6,.097), (2,.091), (3,.083) |
| LV-Haack | (.9,0), (.95,.010), (1,.024), (1.05,.066), (1.1,.084), (1.2,.100), (1.4,.114), (1.6,.117), (2,.113) |
| Parabolic 1 | (.95,0), (.975,.016), (1,.041), (1.05,.092), (1.1,.109), (1.2,.119), (1.4,.113), (1.7,.108) |
| Parabolic 1/2 | (.8,0), (.9,.016), (.95,.042), (1,.100), (1.05,.126), (1.1,.125), (1.3,.100), (1.5,.090), (1.8,.088) |
| Parabolic 3/4 | (.9,0), (.95,.023), (1,.073), (1.05,.098), (1.1,.107), (1.2,.106), (1.4,.089), (1.7,.082) |

### E09 — table-shape interpolation and fineness transformation

```text
T(M) = (1-z)*Tleft(M)+z*Tright(M)   evaluated at the union of both knot sets
c(M) = B(M)*(T(M)/B(M))^(ln(f+1)/ln(4))
```

Source: desktop OR empirical interpolation, `SC:609`, `SC:659`, `SC:677`.
B is the blunt reference, E13 sampled from M=0 to <3 at step 0.05 (`SC:525`),
with endpoint clamping. Power shapes interpolate between blunt/1/4/1/2/3/4/cone
over parameter intervals [0,.25], [.25,.5], [.5,.75], [.75,1], respectively;
z=4 times the displacement within each interval. Parabolic uses cone/1/2/3/4/1
over [0,.5], [.5,.75], [.75,1], with z=2p, 4(p-.5), 4(p-.75).
Haack interpolates Von Karman to LV-Haack with z=3p. Ellipsoid uses its table
alone. The cone used in the endpoint mixtures has
`sinPhi=1/sqrt(1+4f^2)`. After mixing, every table-shape curve undergoes the
fineness transformation, including mixed cone endpoints. A zero table value
remains zero at positive fineness.

### E10 — subsonic fill and stubby-nose floor

```text
c0 = 0.8*sinPhi^2
dmin = (c(Mmin+0.01)-c(Mmin))/0.01
b = Mmin*dmin/(c(Mmin)-c0)
a = (c(Mmin)-c0)/Mmin^b
c(M) = a*M^b+c0                  sampled 0 to <Mmin, step 0.05
floor = (1/3)*0.8/(1+4*f^2)*(1-(f/1.8)^2)
```

Source: desktop OR subsonic fit, `SC:694`; app empirical floor, `SC:809`.
The fill runs only if `c(Mmin)>=.001`, `c0<c(Mmin)-.01` and `dmin>.01`.
Otherwise the existing interpolator clamps below its first knot. The floor
runs only on actual noses of stored-table or OGIVE shape, either optional flag
enabled, and `0<f<1.8`. It replaces smaller values at 0.05-Mach samples through
Mmin and at Mmin itself; for ogives it also replaces smaller values at all
existing knots. It is not reapplied after an above-table analytic continuation.
The 1/3 factor and taper are a bracket/interpolation informed by Mercer's
Centuri TIR-100 nose tests and DeMar's NARAM-37 work, not a calibrated
Mach-resolved law; the code documents missing speed/Reynolds/accuracy metadata.

### E11 — above-table nose continuation

```text
t = clip((M-4)/4,0,1)
k(M) = (1-t)*2.1+t*CpMax(M)
c(M) = u*(k(M)*sinPhi^2+0.5*sinPhi/sqrt(M^2-1))  analytic cone/ogive
c(M) = c(Mend)*(1.59+1.83/M^2)/(1.59+1.83/Mend^2) table shapes
```

Source: app extensions/fit, `SC:364`, `SC:377`. These run only above the
actual final interpolator knot, with `supersonicAero=true`; Fleeman noses use
E07 instead. Mend is taken from the constructed curve, not rounded to a nominal
Mach limit. The high-Mach cone coefficient blends over M4–8. The table-tail
decay borrows Fleeman's Mach dependence; it is not a shape-specific pressure
solution. In particular the nose tables and stubby floor do not implement a
spherical cap or its shock interaction.

### E12 — normal-shock stagnation pressure coefficient

```text
CpMax(M) = 2/(gamma*M^2) * (
  [((gamma+1)^2*M^2)/(4*gamma*M^2-2*(gamma-1))]^(gamma/(gamma-1))
  * (1-gamma+2*gamma*M^2)/(gamma+1) - 1)
```

Source: Rayleigh pitot relation, NACA Report 1135 Eq.100 as identified by the
patch, `SC:416`; gamma=1.4. Used in E11's high-Mach fade, not as a general
surface-pressure integral or blunt-fin correction.

### E13 — stagnation drag on a face or forward radius step

```text
B(M) = 0.85*(1+M^2/4+M^4/40)                           M <= 1
B(M) = 0.85*(1.84-0.76/M^2+0.166/M^4+0.035/M^6)         M > 1
CDstep = B(M)*pi*(rFore^2-rPreviousAft^2)/Aref          rFore > rPreviousAft
```

Source: desktop OR stagnation fit, `BC:1544`, `BC:1273`.
If the previous symmetric component is absent or inactive its radius is zero.
A zero-length component uses its maximum radius as rFore. This discontinuity
term is additional to the component's own pressure drag; an expanding
transition can therefore carry both. Base steps are handled separately below.

### E14 — Kbf's ogive endpoint used by Hybrid

```text
cKbf = cDesktop                                     M <= 0.8
cKbf = cDesktop+S((M-.8)/.2)*(cFleeman-cDesktop)       0.8 < M < 1
cKbf = cFleeman                                     M >= 1
```

Source: app blend, `SC:342`, `SC:390`. Only the E07 ogive-nose scope uses
this extra curve. Both curves include applicable subsonic construction and
floors. The difference is signed: using only positive excess would leave a
secant-ogive step at Mach 1. Supersonic uses its Fleeman curve directly at all
Mach; E14 affects the Kbf endpoint of Hybrid.

## Base drag, boattails and power-on conditions

### E15 — base coefficient and exposed area

```text
Cb(M) = 0.12+0.13*M^2                 M <= 1
Cb(M) = min(0.25/M,1.2/M^2)           M > 1, Supersonic
CbKbf(M) = 0.25/M                     M > 1, Kbf
Ab = pi*(rAft^2-rNextFore^2)           rAft > rNextFore; otherwise 0
CDbase = Cb*Ab/Aref
```

Source: desktop OR/Hoerner-family fit and app high-Mach cap, `BC:1561`,
`BC:1575`, `BC:1349`. Ab uses the next *active* symmetric component, or zero
next radius if none; zero-length parts use their maximum radius. The cap starts
binding at M4.8, algebraically where the two branches meet. The 1.2 constant is
a recovery-scaled approximation below the vacuum magnitude `2/(gamma*M^2)`,
not an exact vacuum law. This same Cb is supplied to fin trailing-edge and
boattail pressure calculations, even when their contribution is booked in the
pressure bucket rather than body-base bucket.

### E16 — boattail estimate, expansion and transonic schedule

```text
f = L/(2*(r0-r1)); Af = pi*(r0^2-r1^2)           r1 < r0, L >= .001 m
g(f) = 1 (f <= 1); (3-f)/2 (1 < f < 3); 0 (f >= 3)
CDsub(M) = Cb(M)*Af/Aref*g(f)
theta = min(atan2(r0-r1,L),0.349)
CDpeak = E(1.20,theta)*Af/Aref
CDbt = CDsub(M)                                 M <= .90
CDbt = (1-S(t))*CDsub(M)+S(t)*CDpeak             .90 < M < 1.05; t=(M-.90)/.15
CDbt = CDpeak                                   1.05 <= M < 1.20
CDbt = E(M,theta)*Af/Aref                        M >= 1.20
```

Source: desktop OR estimate and app transonic fit, `SC:287`.
Kbf uses CDsub at every Mach. The blend evaluates CDsub at the queried Mach,
not frozen at onset. The 0.349 rad turn cap is a separation heuristic; this
does not solve separated flow. All contracting profiles use only end radii
and length here, so a curved boattail and a cone with those same dimensions
receive identical pressure drag. This differs from the target spec's linear
strip estimate and proposed pressure-recovery solver.

### E17 — Prandtl-Meyer expansion magnitude E

```text
nu(M) = sqrt(6)*atan(sqrt((M^2-1)/6))-atan(sqrt(M^2-1))   M > 1; else 0
nuMax = (sqrt(6)-1)*pi/2
nu2 = nu(M)+theta
nu(M2) = nu2
P2/P1 = [(1+.2*M^2)/(1+.2*M2^2)]^(gamma/(gamma-1))
E(M,theta) = 2/(gamma*M^2)*(1-P2/P1)
```

Source: perfect-gas Prandtl-Meyer/isentropic relations; Anderson, *Modern
Compressible Flow* Eq.4.44 for nu as attributed by the code, `SC:436`,
`SC:455`. gamma=1.4. E returns zero for M<=1 or theta<=0. If
`nu2 >= nuMax-1e-6`, E returns `2/(gamma*M^2)` directly. Otherwise the inverse
uses exactly 48 bisections of [M,60], then the interval midpoint. The fixed
upper bound is a numerical limit: turns requiring M2>60 are clipped by the
search, and M>60 is outside its ordered-bracket assumptions. There is no
downstream pressure recovery along the boattail toward its base.

### E18 — nozzle-exit area credit

```text
Ae = pi*(de/2)^2
AbOn = max(0,Ab-Ae)                              core/mixed loadout's aft-most base
capacity = sum_j(nj*Abj)                         motor-carrying pod terminal bases
credit_j = Abj*min(1,Ae/capacity)                capacity > 0; else 0
AbjOn = max(0,Abj-credit_j)
```

Source: Fleeman-family annulus approximation plus app allocation, `BC:1398`,
`BC:1445`. de is a stage's nozzle exit diameter (m), not throat/case diameter.
Credit requires de>0 and the stage thrusting flag, and either optional model
flag. Core or mixed loadouts credit only the last symmetric direct child in
the stage's own line. For pods-only loadouts, actual loaded mounts (declared
mounts when none are loaded for static preview) select the nearest pod lines;
decorative pods and intermediate bases do not receive credit. nj is the
number of base instances per stage instance. Overrides can suppress a
base's contribution after allocation; its credit is then lost, not transferred.
Multiplying by active instances preserves one area budget per stage instance.
There is no plume expansion, nozzle-size supersonic augmentation or altitude
dependence of this drag credit. Fin trailing-edge drag receives no nozzle credit.

### E19 — related pressure thrust in flight

```text
deltaF = sum_stage(Nstage*Ae*(101325-Pambient))
F = max(0,FcurveSum+deltaF)          when deltaF != 0; otherwise FcurveSum
```

Source: pressure part of the rocket thrust equation and app reference-pressure
assumption, `RK:439`, `RK:527`, `RK:329`. This is thrust (N), not drag.
Only stages with a current motor-curve thrust above zero and de>0 are credited,
once per stage number, scaled by stage instances. Both optional flags admit it;
Hybrid inherits that admission. The curve reference pressure is assumed to be
101325 Pa; it is not measured for every motor curve. Cluster exits are represented
by the stage's equivalent total area, including staggered clusters from the
first positive-thrust motor. The app does not solve chamber/nozzle flow.

## Planar fins: geometry, normal force and interference

These formulas apply to freeform, trapezoidal and elliptical FinSet components.
Fin geometry is sampled from the actual outline, rather than silently replacing
freeform fins with a trapezoid. Let s be exposed span, S one fin's planform area,
c the computed mean aerodynamic chord (MAC), r body radius at the fin, t fin
thickness, and Gamma/GammaLE the effective mid-chord/leading-edge sweep angles.

### E20 — sampled fin geometry

```text
AR = 2*s^2/S
dy = s/47; yi = i*dy; i = 0..47
li = trail_i-lead_i; Asampled = dy*sum(li)
c = dy*sum(li^2)/Asampled
xMAClead = dy*sum(lead_i*li)/Asampled
yMAC = dy*sum(yi*li)/Asampled
cosGamma = sum_i=1..47(dy/hypot(deltaMidchord_i,dy))/47
cosGammaLE = sum_i=1..47(dy/hypot(deltaLead_i,dy))/47
Rroll = dy*sum(chordLength_i*(rFront+yi)^2)
```

Source: desktop OR numerical geometry, `FC:417`, `FC:533`; 48 stations.
Outline edges are intersected with station lines; x is clamped to edge endpoint
bounds; nearly horizontal edges are skipped when `MathUtil.equals(y1, y2, 0.001)`
holds — a RELATIVE test, |y1 − y2| < 0.001·|y2| (both ends within 0.0005 m of zero when
y2 is that small; inherited `MathUtil.java`), not a fixed 1 mm distance. Lead/trail are
the extreme intersections, while signed crossings build chordLength for roll.
Invalid intersections and negative chord lengths are zeroed; chordLength is
capped at trail-lead. MAC uses envelope li; planform S is the component's area,
not Asampled. Sweep cosines are averages of segment cosines, not the cosine of
one whole-outline slope. Zero sampled area yields zero MAC properties.

### E21 — single-fin normal-force weight

```text
a = min(alpha,pi-alpha,20*pi/180)
Q(M) = sqrt(1+(1-M^2)*(s^2/(S*cosGamma))^2)
Csub(M) = 2*pi*s^2/(Aref*(1+Q(M)))                         M <= .9
K1 = 2/beta
K2 = ((gamma+1)*M^4-4*beta^2)/(4*beta^4)
P = (gamma+1)*M^8+(2*gamma^2-7*gamma-5)*M^6+10*(gamma+1)*M^4+8
K3 = P/(6*beta^7)
scale = 2*max(1-1/(2*AR*beta),.25)
Csuper(M,a) = (S/Aref)*scale*(K1+K2*a+K3*a^2)               M >= Mtop
Mtop = clip(sqrt(1+1/AR^2),1.2,1.5)                        positive AR
```

Source: desktop OR Barrowman/Diederich and Busemann lineage, plus app finite-span
extension, `FC:611`, `FC:684`, `FC:714`, `FC:871`. gamma=1.4, beta here is
`betaSupersonic`. Zero fin area, span or cosGamma below the kernel epsilon gives
zero. Nonpositive AR falls back to Mtop=1.5. At zero angle the high-Mach law
approaches `(S/Aref)*4/beta` with a finite-span tip correction. Its .25 floor
is an implementation safeguard, not an independently validated low-AR theory.
The Mtop construction draws on Jones and Cohen's rectangular-wing `AR*beta>=1`
condition; it does not enforce a supersonic leading edge on swept fins.

### E22 — Supersonic transonic normal-force bridge

```text
C(.9) = Csub(.9)
C'( .9) = 2*.9*pi*s^6/((S*cosGamma)^2*Aref*Q(.9)*(1+Q(.9))^2)
C(Mtop) = Csuper(Mtop,a)
C'(Mtop) = (S/Aref)*(scale'*k+scale*k')
C''(.9) = 0
k = K1+K2*a+K3*a^2
scale' = M/(AR*beta^3) if 1-1/(2*AR*beta) > .25; otherwise 0
K1' = -2*M/beta^3
K2' = -(gamma+1)*M^3/beta^6+2*M/beta^4
P' = 8*(gamma+1)*M^7+6*(2*gamma^2-7*gamma-5)*M^5+40*(gamma+1)*M^3
K3' = P'/(6*beta^7)-7*M*P/(6*beta^9)
k' = K1'+K2'*a+K3'*a^2
```

Source: app quartic interpolation and analytic derivative, `FC:641`, `FC:726`,
`FC:745`. In .9<M<Mtop the unique fourth-degree polynomial satisfying these
five conditions is evaluated. Derivatives hold a fixed at its current clamped
value. This is not the fifth-degree interpolation claimed in the old target
spec. The normal-force bridge changed in October; the separate CP and roll
damping Mach bands did not.

### E23 — Kbf endpoint's normal-force law

Kbf retains Csub below .9. It tabulates K1/K2/K3 from E21 at M1.5 through 4.9
in .1 steps (`FC:589`), linearly interpolates and clamps above that range. For
M>=1.5 its single-fin weight is `(S/Aref)*(K1+K2*a+K3*a^2)` with no scale.
In .9<M<1.5 a quartic has E22's subsonic value/slope and zero lower curvature,
upper value from that table and upper slope
`-(S/Aref)*2*1.5/(1.5^2-1)^(3/2)` (`FC:656`, `FC:665`). The upper slope omits
the higher-angle terms' derivatives. Source: desktop OR with upstream #3236's
fixed lower-endpoint derivative correction. This defines the Hybrid endpoint,
not Supersonic's analytic branch.

### E24 — orientation, fin-count and body-fin interference

```text
lambda = r/(s+r)                           invalid/infinite lambda becomes 0
J = (1+lambda^4)*(.5*atan(.5*(1/lambda-lambda))+pi/4)
    -lambda^2*((1/lambda-lambda)+2*atan(lambda))
KWB = (2/pi)*J/(1-lambda)^2
KBW = (1+lambda)^2-KWB
fa = min(1,.5+afterLength/rootChord)
CNa = CNa1*sin(thetaFlow-thetaFin)^2*etaFin*(KWB+fa*KBW)
etaFin = 1 (1..4 overlapping fins); .948 (5); .913 (6); .854 (7); .81 (8); .75 otherwise
```

Source: NACA Report 1307 Eq.14 for KWB, `FC:891`; desktop fin-count factors
and orientation, `FC:272`; app carryover allocation, `FC:315`, `FC:172`.
KWB is set to 1 for lambda<=epsilon and 2 for lambda>=1-1e-9. The factor
applies at every Mach in Supersonic. Interference count includes sibling fin
sets with `lead_i < trail-.005` and `trail_i > lead+.005`, using metres;
this excludes mere touching and very short overlaps (`FC:1363`, `FC:1508`).
If the current root's axial length is below .007 m, only its own fin count is
used (`FC:1369`). afterLength is the nonnegative physical body length
behind the fin root trailing edge. The walk sorts symmetric siblings within
the parent's container by axial station, includes contiguous lengths and only
new aft length for overlaps, stops at a gap, and deducts fin overhang. Station
tolerance is 1e-6 m. With no parent or usable root chord fa=1; a flush base
gives fa=.5. Supersonic assigns this combined load to fin MAC CP: it does not
give KBW its own body CP, and it does not add Kbf again.

### E25 — Kbf carryover and finite-angle fin load

```text
Wpanel = CNa1*sin(thetaFlow-thetaFin)^2*etaFin*(1+lambda)
Wcarry = lambda*Wpanel
xCarry = rootLead+.25*(rootTrail-rootLead)
xCPkbf = (Wpanel*xMACcp+Wcarry*xCarry)/(Wpanel+Wcarry)
CNfin = Wtotal*min(alpha,20*pi/180)
Cmfin = CNfin*xCP/dref
```

Source: app Kbf approximation to slender-body carryover plus desktop stall cap,
`FC:323`, `FC:367`, `FC:377`. Wcarry is added only for Kbf, not Supersonic;
invalid root endpoints fall back to xMACcp. Supersonic Wtotal is E24's CNa and
uses its MAC CP directly. Side/yaw terms are zero locally, including on one/two
fin configurations. The cap is a force-model limit, distinct from the
calculator's 17.5-degree stall-event threshold (`BC:123`).
If abs(Wpanel+Wcarry)<epsilon^2, the coordinate average uses
`(xMACcp+xCarry)/2` with weight zero instead of the quotient (desktop
`Coordinate.java:295`). Carryover is admitted only for lambda>0.

## Fin CP and assembly CP

### E26 — bounded supersonic CP along the MAC

```text
X = AR*betaConditions
Fsource(X) = (X-.67)/(2*X-1); Fsource'(X) = .34/(2*X-1)^2
F(X) = .25                                                X <= .84
F(X) = H(X; .84,1,.25,.33,0,.34)                          .84 < X < 1
F(X) = Fsource(X)                                         X >= 1
xMACcp = xMAClead+F(X)*c                                  M >= 2
```

Source: NACA Report 1307 Eq.63 lineage with Fleeman's rounded .67, desktop OR
and upstream #3262 bounded fallback, `RC:128`, `RC:211`, `FC:974`.
The lower bridge is a generic fallback, not measured low-AR physics. It avoids
the old expression's pole at X=.5. At M<=.5, F=.25 regardless of AR.

### E27 — CP transonic interpolation

```text
tM = (M-.5)/1.5; X2 = AR*sqrt(3)
delta = F(X2)-.25; e = X2*F'(X2); R = e/delta
Ftrans = .25+(10*delta-6*e)*tM^2+(-20*delta+14*e)*tM^3
         +(15*delta-11*e)*tM^4+(3*e-4*delta)*tM^5            R <= 5/3
Ftrans = .25+delta*[(10/3)*tM^3-(10/3)*tM^4+tM^5]^(R/(5/3)) R > 5/3
```

Source: desktop OR interpolation with upstream #3262 monotonic continuation,
`RC:165`. Runs only .5<M<2. If delta<=0 it returns .25 without dividing.
F' is zero below .84, the derivative of E26's cubic inside the bridge and
Fsource' above 1 (`RC:222`). The normalizing derivative e uses the Mach-2
endpoint slope. This formula applies to planar and tube fin CP in every model;
it is independent of Supersonic's per-fin normal-force bridge.

### E28 — instance transform and assembly weighting

```text
xAbsolute = (instanceTransform*componentCP).x
CmInstance = CNinstance*xAbsolute/dref
Wassembly = sum_i(Wi)
xDerivativeCP = sum_i(Wi*xAbsolute_i)/Wassembly
CNassembly = sum_i(CNi); CmNormal = sum_i(Cmi)
```

Source: desktop OR assembly build-up, `BC:646`, `BC:718`, `AF:519`.
Each active instance is evaluated; transformed CP y,z are reset to zero in
this build-up. Moments are about the reference origin (nose). Total weight
numerically equal to zero (`MathUtil.equals`) returns the zero coordinate
(`AF:120`, `AF:159`); a quotient is not taken.
The derivative CP weights need not equal force weights after a fin stalls.

### E29 — reported CP above 20 degrees

```text
xReported = dref*CmNormalZeroRate/CNzeroRate
staticMargin = (xReported-xCG)/dref
```

Source: app reporting correction, `AC:128`, `AC:149`, `BC:396`; margin `API:637`.
The CP correction applies strictly above finite alpha=20*pi/180, and only if
CN and Cm are finite, abs(CN)>1e-8, dref is finite/positive and the quotient
is finite. Otherwise x is NaN; it is not clipped or replaced with derivative
CP. It preserves derivative CP y,z and weight. Pitch, yaw and roll rates are
zeroed for the separate normal-force evaluation; drag and damping do not enter
that reported lever arm. At/below 20 degrees the derivative CP is reported.
Hybrid uses blended zero-rate forces before dividing (E02). Static margin's
sign convention follows the app's aft-positive coordinates, not the target
spec's differently signed illustrative moment formula.

## Fin pressure/wave drag, including rounded and airfoil sections

Let tau=t/c; this thickness ratio is distinct from lambda=r/(s+r).
Pressure drag returns zero for negligible fin area. A named section is used
only when `rogersKbf || supersonicAero`; Classic ignores those extension inputs.

### E30 — transonic thickness-wave magnitude

```text
betaT(M,tau) = [(gamma+1)*M^2*tau]^(1/3)       similarity threshold K = 1
betaEff = max(sqrtSafe(M^2-1),betaT)
Wpeak = Fsection*tau^2/betaEff(1.05,tau)
W(M) = 0                                    M <= .90 or tau <= 0
W(M) = Wpeak*S((M-.90)/.15)                 .90 < M < 1.05
W(M) = Fsection*tau^2/betaEff(M,tau)          M >= 1.05
```

Source: app transonic construction using thin-airfoil/transonic-similarity
scaling, `FC:825`, `FC:859`. The code attributes the similarity argument to
Liepmann and Roshko / Ashley and Landahl ch.12; the onset, peak band and
limiter are an implementation choice, not a fully solved transonic flow.
No additional `4*alpha^2/beta` induced-drag term from the target spec is
added to this pressure law.

### E31 — leading-edge sweep relief on thickness wave drag

```text
C = cosGammaLE; Mn = M*C
Gwave = C^2                                             Mn <= .90
Gwave = C^2+(1-C^2)*S((Mn-.90)/.15)                     .90 < Mn < 1.05
Gwave = min(1,max(C^2,sqrt(M^2-1)*C/sqrt(Mn^2-1)))       Mn >= 1.05
```

Source: app fitted bridge to sheared-wing strip theory, `FC:782`; code names
Puckett-Stewart and DATCOM 4.1.5.1 as lineage, without a specific equation
number. The clamping limits the factor to unity. It affects thickness wave
drag only, not the rounded-edge law below. Unswept fins have Gwave=1.

### E32 — unnamed AIRFOIL and named section drag

```text
CDairfoil = W(M; Fsection=16/3,tau)*Gwave*S/Aref
CDnamed = [W*Gwave+baseFrac*Cb*tau+CLE(M)*C^2*(2*rLE/c)]*S/Aref
```

Source: thin-airfoil/Ackeret shape integrals (DATCOM 4.1.5.1 lineage), with
desktop edge/base fits and app gates, `FC:1201`, `FC:1263`, `FC:1342`.
Subsonic section profile drag is represented in E37's friction form factor;
there is no other sharp-section pressure term below onset. rLE term is zero
when rLE<=0 or c<=epsilon. The code's explicit named-section defaults/clamps:

| Section | Fsection | baseFrac | rLE |
|---|---|---|---|
| hexagonal | 1/a1+1/a2 | 0 | input |
| naca | 16/3 | 0 | 1.1019*tau^2*c, replacing input |
| doublewedge | 1/(m*(1-m)) | 0 | input |
| biconvex | 16/3 | 0 | input |
| hexbluntbase | 1/a1 | 1 | input |
| singlewedge | 1 | 1 | input |

For positive input LE/TE diamond lengths and usable c, a1/a2 are their
chord fractions clipped to [.05,.95]; otherwise each defaults to 1/3 when
used. Doublewedge uses m=.5 if unset, otherwise a1 clipped to [.1,.9].
The naca radius formula is a NACA-family geometry approximation, not a new
Mach-dependent bluntness solver. Named-section Kbf uses a different W:
zero through .9, a linear ramp to `Fsection*tau^2/sqrt(1.2^2-1)` through
1.2, then `Fsection*tau^2/sqrt(M^2-1)`, with Gwave replaced by C^2
(`FC:1322`). Unnamed AIRFOIL under Kbf uses E30 and E31 just as Supersonic
does. This distinction matters to Hybrid and to desktop-imported fins.

### E33 — rounded-edge fit and desktop ROUNDED/SQUARE paths

```text
CLE(M) = (1-M^2)^(-.417)-1                   M < .9
CLE(M) = 1-1.785*(M-.9)                      .9 <= M < 1
CLE(M) = 1.214-.502/M^2+.1095/M^4            M >= 1
CDrounded = [CLE(M)*C^2+Cb/2]*s*t/Aref
CDsquare = [B(M)*C^2+Cb]*s*t/Aref
```

Source: desktop OR fits, `FC:1210`, `FC:1348`. ROUNDED and SQUARE take
these paths at all Mach even with Supersonic enabled; ROUNDED gets no added
biconvex thickness term. Without an optional flag, AIRFOIL uses CLE*C^2
on the same frontal area with zero trailing-edge term. Named-section edge
drag also evaluates CLE at full freestream Mach and multiplies by C^2.
It does not use the target spec's normal-Mach swept-cylinder `cos^3` law
or its modified-Newtonian cylinder limit. Radius alone on an unnamed
AIRFOIL does not activate the named-section edge model.

## Skin friction and the drag interference factor

One Reynolds number based on total configuration aerodynamic length La feeds
the body's and fins' surface friction. There is no per-fin chord-Reynolds
transition calculation in this path. epsilon is a component finish's roughness
height (m), not the kernel's numerical epsilon.

### E34 — turbulent friction and compressibility

```text
Re = V*La/nu
Cf0 = .0148                                  Re < 1e4
Cf0 = 1/(1.50*ln(Re)-5.6)^2                  Re >= 1e4
c1 = 1-.1*M^2
c2OR = (1+.15*M^2)^(-.58)
v = clip((M-3.5)/1,0,1)
c2 = (1-v)*c2OR+v*(1+.144*M^2)^(-.65)        Supersonic turbulent branch
c2 = c2OR                                   Kbf turbulent branch
Cf = Cf0*c1                                 M < .9
Cf = Cf0*[c1*(1.1-M)/.2+c2*(M-.9)/.2]       .9 <= M < 1.1
Cf = Cf0*c2                                 M >= 1.1
```

Source: desktop OR engineering fits and app high-Mach fade, `BC:1057`,
`BC:1121`. nu is kinematic viscosity (m^2/s). The high-Mach fit blends from
M3.5 to 4.5, not M4 to 4.5 as one code comment suggests. The code labels it
Van Driest II and attributes it to Hopkins & Inouye/NASA TN D-6945, but that
attribution is not established: D-6945 is by Hopkins alone and its charts
do not establish this 0.144/.65 closed-form fit. Treat it as an engineering
fit of unresolved primary provenance, not the full Van Driest transformation.
Wall temperature is not modeled. Roughness selection E36 can hide this fade.

### E35 — optional partial-laminar branch

```text
Cf0 = .0133                                  Re < 1e4
Cf0 = 1.328/sqrt(Re)                          1e4 <= Re < 5.39e5
Cf0 = 1/(1.50*ln(Re)-5.6)^2-1700/Re          Re >= 5.39e5
z = clip((Re-1e6)/2e6,0,1)
c1 = 1-.1*M^2*z
c2 = 1+z*((1+.045*M^2)^(-.25)-1)
Cf = Cf0 * the same .9–1.1 Mach interpolation between c1,c2 as E34
```

Source: desktop OR Blasius/transitional engineering fits, `BC:373`, `BC:1075`.
Enabled only by the rocket's perfectFinish setting and an optional model flag;
default off. It bypasses the Supersonic high-Mach turbulent fade entirely.
Its weaker compressibility law can increase high-Mach friction relative to the
default, so it cannot be described simply as a drag reduction. It is not the
target spec's general Eckert reference-temperature model.

### E36 — roughness floor and selection

```text
Rrough = 1-.1*M^2                            M < .9
Rrough = (1+.18*M^2)^(-1)                    M > 1.1
Rrough = (1-.1*.9^2)*(1.1-M)/.2
         +(1+.18*1.1^2)^(-1)*(M-.9)/.2      .9 <= M <= 1.1
Cfrough = .032*(epsilon/La)^.2*Rrough
Cfcomponent = max(Cf,Cfrough)                fully turbulent
Cfcomponent = Cfrough if Re>1e6 and Cfrough>Cf; otherwise Cf   partial laminar
```

Source: desktop OR roughness fit, `BC:946`, `BC:961`, `BC:1170`.
The roughness Mach bridge uses values fixed at its endpoints, whereas E34/E35
use c1/c2 at the queried Mach. Finish roughness comes from OpenRocket's enum,
not the target spec's RASAero sand-roughness table.

### E37 — wetted-area friction, body fineness and fin interference

```text
CDbodyComponent = Cfcomponent*Awet/Aref
bodyLength = maxX-minX+.0001
fBody = bodyLength/(2*rMax)
bodyCorrection = 1+1/(2*fBody)
CDbodyFriction = bodyCorrection*sum_instances(CDbodyComponent)
CDfinFriction = 1.8*Cfcomponent*(1+2*t/c)*2*S/Aref
```

Source: desktop OR wetted-area build-up and technical documentation Eq.3.85
with upstream #3237's diameter correction, `SC:236`, `BC:980`, `BC:1043`;
app fin multiplier, `FC:1026`, `FC:1123`. maxX/minX/rMax come from non-overridden
active symmetric components; appendage friction is outside bodyCorrection.
The 1.8 multiplier runs in Kbf and Supersonic at every Mach. It is a fin
friction-scaled empirical drag addition, not a physical junction corner law
proportional to thickness squared. Its provenance and sensitivity are examined
in [the interference scorecard](scorecard-junction-2026-08-25.md), and the
later fin-increment evidence in [the fins-on re-read](scorecard-finson-reread-2026-10-11.md).
It is distinct from the normal-force interference factors E24/E25.

## Completed drag, overrides and dynamic terms

### E38 — drag summation and overrides

```text
CD = CDfriction+CDpressure+CDbase+CDoverride
CDoverrideScalar = Ninstances*userCD
CDoverrideRatio = Ninstances*ratio*(CDbodyFriction+CDbodyPressure+Ibase*CDbodyBase)
```

Source: desktop OR scalar override and app body-ratio extension, `BC:624`,
`BC:1637`. Overrides suppress the component's computed friction, pressure and
base loops; descendants overridden by an ancestor are skipped. Body ratio
reference comprises symmetric components only, including scalar body overrides
and forward-step pressure, with Ibase=1 or 0 according to the selected class.
A stage/assembly override is not itself a symmetric component and does not
enter that reference. The ratio is applied at every Mach, in both Hybrid
endpoints before blending. Friction/pressure/base scratch sums are computed
before the ratio override, so it does not recursively include its own drag.

### E39 — axial drag at angle of attack

```text
a = min(clip(alpha,0,pi),pi-clip(alpha,0,pi))
m(a) = H(a; 0,17*pi/180,1,1.3,0,0)               a < 17*pi/180
m(a) = polynomial on [17*pi/180,pi/2] with
       values 1.3,0; slopes 0,0; curvature 0 at pi/2   otherwise
CDaxial = m(a)*CD             alpha < pi/2; otherwise -m(a)*CD
```

Source: desktop OR angle fit, `BC:1585`, `BC:1608`. The second polynomial
is quartic (five constraints). Hybrid blends already-computed CDaxial, not
CP or angles. This is separate from a thin-airfoil induced-drag law.

### E40 — roll forcing and damping of planar fins

```text
CrollForce = (yMAC+r)*CNa1*(1+lambda)*cant/dref
stallRoll = clip(1-(alpha-20*pi/180)/(10*pi/180),0,1)     alpha > 20*pi/180
Croll = CrollForce*stallRoll-CrollDamp                   stallRoll=1 below threshold
```

Source: desktop OR, `FC:342`, `FC:903`. The roll forcing retains (1+lambda),
even though Supersonic pitch normal force uses E24. Roll rate omega is rad/s:
abs(omega)<.1 returns zero damping. If
`abs(omega)*(r+s)/V > 15*pi/180`, the code uses
`sign(omega)*(s/48)*2*pi/(betaConditions*Aref*dref)
 *sum_i(chordLength_i*di*min(abs(omega)*di/V,15*pi/180))`,
where di=r+s*i/48. Otherwise M<=.9 uses
`2*pi*omega*Rroll/(Aref*dref*V*betaConditions)`; M>=1.5 uses
`(s/47)/(Aref*dref)*sum_i(chordLength_i*(r+yi)
 *(K1*ai+K2*ai^2+K3*ai^3))`, ai=omega*(r+yi)/V.
The latter uses the desktop K tables from E23, even under Supersonic; its
coefficients clamp beyond 4.9. Intermediate Mach linearly blends results
evaluated at .89 and 1.51 with weights `(1.5-M)/.6` and `(M-.9)/.6`.
These dynamic terms have not received the static fin high-Mach extension.

### E41 — pitch and yaw damping

```text
Lcache = sum_activeSymmetric(Li)
dcache = sum_activeSymmetric(Aplanform_i)/Lcache          positive Lcache; else 0
mu = .275*dcache*(xCG^4+(Lcache-xCG)^4)/(Aref*dref)
     + sum_finsets(.6*min(Nfin,4)*S*abs(xMidchord-xCG)^3/(Aref*dref))
CpitchDamp = sign(pitchRate)*min(3*mu*(pitchRate/V)^2,Cm)
CyawDamp = sign(yawRate)*min(3*mu*(yawRate/V)^2,Cyaw)
CmFinal = Cm-CpitchDamp; CyawFinal = Cyaw-CyawDamp
```

Source: desktop OR empirical damping, `BC:1706`, `BC:1728`, `BC:634`.
The cached body sums and fin-set loop are over active component definitions;
the fin lever arm uses the first absolute location. They are not a separate
instance-resolved supersonic dynamic-derivative model. The factor 3 is the
desktop apogee-turn heuristic. Reported CP E29 uses zero-rate moments instead.

## Tube fins and other appendages

The Supersonic switch does not replace every component calculator. Tube fins
keep the desktop ring-airfoil normal-force model and tube pressure-drop model;
they do share the bounded CP correction. These are relevant limits when a
design combines conventional fins and tube fins.

### E42 — tube-fin geometry, force and friction

```text
ARtube = 2*ri/c; ARprime = 2*ARtube/pi
CNaTube = 2*(ARprime/(1+ARprime))*pi^2*ri*c/Aref
theta1 = acos(ro/(ro+r)); theta2 = pi/2-theta1
interstice = ro*sqrt((r+ro)^2-ro^2)-ro^2*theta1-r^2*theta2
AwetTube = 2*c*((pi-theta1)*ro-theta2*r)
CNtube = CNaTube*min(alpha,20*pi/180)
xTubeCP = c*Fcp(M,ARtube)
CrollDampTube = (r+ro)*omega/V*CNaTube/dref
CDfrictionTube = Cfcomponent*AwetTube/Aref
```

Source: desktop OR with Ribner, *The ring airfoil in nonaxial flow*, 1947,
Eq.5 for the ring-force lineage, `TF:79`, `TF:132`, `TF:168`, `TF:243`.
ri/ro are inner/outer tube radii; c is tube length. Fcp is E26/E27 with .25
below .5, not the planar-fin AR. CNaTube itself has no Mach correction.
Outer radius<.001 m zeroes the non-axial output. Cant is fixed at zero, so
roll forcing is zero; Cm follows E28 and side/yaw are zero. Outer wetted area
subtracts the masked body area; different body/tube finishes can therefore
make that subtraction inaccurate. There is no 1.8 planar-fin friction factor.

### E43 — open-tube/launch-lug pressure drag

```text
d = 2*ri; Ai = pi*ri^2; Afront = pi*(ro^2-ri^2)
Red = V*d/nu
fDarcy = .25/[log10(epsilon/(3.7*d)+5.74/Red^.9)]^2
deltaP = fDarcy*c*rho*V^2/(2*d)
Ctube = 2*deltaP/(rho*V^2)
CDtube = [Ctube*Ai+.7*(B+Cb)*Afront]/Aref
CDpressureTubeFin = CDtube+(B+Cb)*interstice/Aref
```

Source: desktop OR Swamee-Jain/Darcy-Weisbach approximation. The unpatched
[TubeCalc.java](https://github.com/openrocket/openrocket/blob/release-24.12/core/src/main/java/info/openrocket/core/aerodynamics/barrowman/TubeCalc.java)
at lines 61–74 supplies the tube law; `TF:254` adds interstice drag.
TubeCalc returns zero for V below numerical epsilon; Ai below epsilon skips
the internal-flow term. Launch lugs inherit the same pressure law, with zero
surface friction and no non-axial force in desktop LaunchLugCalc.java:16.
This is an incompressible pipe-pressure-drop approximation used at all Mach,
not a compressible supersonic duct-flow solution.

### E44 — rail-button pressure drag

```text
Abtn = Hbtn*Douter-(Douter-Dinner)*Hinner
Rex = V*x/nu; deltaBL = .37*x/Rex^.2
Mlocal = M*(Hbtn-.5*deltaBL)/Hbtn             Hbtn > deltaBL
Mlocal = M*Hbtn/(2*deltaBL)                   otherwise
CDeffective = CDcylinder(Mlocal)*(Mlocal/M)^2
CDbutton = mean_instances(CDeffective)*B(M)*Abtn/Aref
```

Source: desktop OR fit, unpatched
[RailButtonCalc.java](https://github.com/openrocket/openrocket/blob/release-24.12/core/src/main/java/info/openrocket/core/aerodynamics/barrowman/RailButtonCalc.java):49.
The cylinder table is attributed to Gowen and Perkins, NACA TN2960 Fig.7:
M `[0,.2,.3,.4,.5,.6,.7,1,1.6,2,2.8,100]`, CD
`[1.2,1.22,1.25,1.3,1.4,1.5,1.6,2.1,1.5,1.45,1.33,1.33]`.
At Mach<=numerical epsilon, mean CDeffective is the fixed desktop value
`8.786395072609939e-4`. Friction and non-axial output are zero. The boundary-layer
law and linear mean-speed approximation are desktop assumptions, without a
specific established primary equation citation in that implementation.
Body-proportional appendage overrides instead use E38.

## Differences from the 2026-08-03 target spec

The local research spec predates the model's implementation phases. It is a
record of intended methods, not the authority for these equations. Its SOSE
pressure propagation, Taylor-Maccoll boundary solution, full Van Driest II
transformation, Eckert wall-temperature method, spherical-cap and modified-
Newtonian fin treatment, Jorgensen charts and altitude-extended atmosphere
are not implemented by this aerodynamic switch.

| Target topic | Executed treatment |
|---|---|
| Body Mach-dependent pressure integration and CP | Nose CNa growth fit capped at M5; slender CP plus Galejs; other symmetric normal forces remain slender (E03–E04) |
| Nose wave drag | Desktop sampled curves/tables plus Fleeman ogive construction and above-table tails (E06–E12); no minimum-drag analytic Von Karman replacement |
| Boattail linear strip/SOSE | Exact 2D Prandtl-Meyer turn magnitude, fitted transonic schedule and angle cap; no recovery integration (E16–E17) |
| Base vacuum limit | Recovery-scaled cap 1.2/M^2, not exact vacuum coefficient (E15) |
| Power-on drag and thrust | One geometric area budget per stage instance and pressure thrust; no plume solver (E18–E19) |
| Fin grid extension | Analytic K coefficients for static Supersonic normal force; desktop grid still used for roll damping and Kbf (E21–E23, E40) |
| Fin transonic CN/CP | Quartic CN bridge to per-fin top; bounded CP law with its independent .5–2 Mach band (E22, E26–E27) |
| Fin shape/LE terms | Six named sections plus desktop Rounded/Square; thickness similarity limiter and sweep blend; full-Mach cos^2 bluntness, no separate lift-induced pressure drag (E30–E33) |
| Interference | Exact slender-body split for Supersonic static load, single MAC placement; empirical 1.8 friction multiplier for drag (E24, E37) |
| Hypersonic friction | Engineering-fit fade M3.5–4.5; no wall temperature or full transformation; partial-laminar branch bypasses it (E34–E36) |

## Validation status and limits

The [validation README](README.md), [machine-readable anchors](anchors.json),
[fixtures](fixtures/) and [scoring implementation](score.mjs) define the
comparison, reference areas, base-included/excluded accounting and tolerances.
Scorecards are dated evidence for the specified kernel and anchor revision.
No new tunnel test or flight measurement was made for this derivation.

The latest recorded fins-on re-read has **191 gated coefficient points**, not
191 rockets or flights: Supersonic **80/191**, Hybrid **80/191**, Kbf **38/191**,
Classic **11/191**, on the stated v0.179 kernel and re-read anchors
([2026-10-11 scorecard](scorecard-finson-reread-2026-10-11.md)). These are
historical recorded scores, not a fresh score run for this document. The current
anchors still give 191 using the scorer's gate flags and Mach bounds; counting
all points in gate-marked series without those bounds would give a different
denominator. Anchor changes make percentages across revisions incomparable.

| Evidence | What it tests and what remains limited |
|---|---|
| ARCAS Short/Long, NASA TN D-4013/D-4014 | Sharp-section fins-on drag and supersonic CP; transonic drag underprediction and body/fin compensation remain. [Fins-on re-read](scorecard-finson-reread-2026-10-11.md) includes the tested-Mach versus fairing distinction and the unresolved fins-on tolerance provenance. |
| ARCAS fins-off | Body drag independently of fin drag. [Direct-report digitization](scorecard-finsoff-figs-2026-08-25.md) and [independent re-read](scorecard-finsoff-reread-2026-08-29.md) constrain subsonic body error; sting-dominated base pressure must not be treated as free-flight base drag. |
| Subsonic ARCAS CP | [Informational reads](scorecard-subsonic-cp-2026-10-11.md) disagree and do not gate. At M.60 Supersonic lies aft of the reads, displaying more margin than measured; its NACA carryover does not establish conservative stability. |
| Basic Finner | Free-flight drag, CNa and CP at the Machs in anchors.json, roughly M1.056–4.473 for drag and to 4.127 for CNa/CP. The additional [tunnel series](scorecard-coverage-2026-10-11.md) is informational and disagrees with free-flight near the peak. |
| NACA RM A53D02 | 29 gated free-flight drag points M.60–10.01, plus an informational RASAero prediction series. It tests drag on that geometry, not high-Mach CP or all fin shapes. [Re-fixture](scorecard-anchors-2026-08-25.md), [Phase 5](scorecard-phase5-2026-08-25.md). |
| AGARD HB-2 | Blunt/flare-body drag, CNa and CP anchors M1.5–10, with series-specific gate bounds; spherical-cap bluntness and Mach-dependent flare effectiveness are missing. [Phase 4](scorecard-phase4-2026-08-04.md) is historical, with its own anchor denominator. |
| NASA TR R-100 afterbodies, cylinders and small article | [Figure 13(a)](scorecard-r100-fig13a-2026-10-07.md) and [coverage additions](scorecard-coverage-2026-10-11.md) are informational; boattail geometry/pressure errors and subsonic base/friction excess remain. |
| AIRFOIL without a named section | [Sharp-airfoil cell](scorecard-nosection-2026-08-29.md) checks the imported section path separately from the named double-wedge fixture. |

The transonic total drag peak can be too low, so predicted apogee for a flight
through Mach 1 can be too high. Subsonic body drag and finite-angle force laws
also have limits; a passing total CD can conceal compensating component errors.
Rounded and arbitrary freeform fins have regression coverage, but the sharp-fin
tunnel fixtures do not validate every rounded section or freeform outline.

The analytic fin CN branch assumes thin fins and attached supersonic flow; the
per-fin Mtop rule comes from rectangular-wing theory and can engage while a
swept leading edge remains subsonic. Airfoil section drag inputs do not change
normal-force or CP formulas. The fin stall cap, zero side-force approximation,
generic low-AR CP fallback and desktop dynamic damping limit high-angle use.
Reporting a force-consistent CP above 20 degrees repairs a lever-arm report;
it does not validate the post-stall force law.

The model has no aerodynamic-heating/wall-temperature calculation, real-gas
correction, general separated-flow solver, complete plume model or SOSE body
integration. Above the measured high-Mach anchors it extrapolates. Its body
normal-force growth freezes at M5; static fin formulas continue analytically,
but roll damping's table clamps at M4.9. The boattail inverse has the finite
Mach-60 bracket described in E17. There is no implemented warning tied to the
target spec's RASAero `rBase/rFore<.5` validity annotation. The switch does not
extend the ISA atmosphere or validate high-altitude trajectories.

Program verification is separate: [engine regression tests](../packages/engine/src/)
include supersonicNose, supersonicFinSlope, transonicFinCNa, finAfterbody,
finThicknessWave, finProfileDrag, finInterferenceFriction, boattailWaveDrag,
supersonicBaseFriction, hybridAero and forceConsistentCp. The JVM/TeaVM
[differential harness](../engine-java/scripts/difftest.mjs) compares the same
patched kernel across runtimes; agreement there does not establish agreement
with desktop OpenRocket or measured flight. This document introduces no new
aerodynamic behavior and makes no default-model recommendation.

## Published source records

Equation-level primary attribution is provided above where the implementation
establishes it. Where it does not, the text labels a desktop OR correlation or
fit rather than inventing a paper equation number. Useful public records:

- [NACA Report 1135, compressible-flow equations](https://ntrs.nasa.gov/citations/19930091059): normal shocks and Prandtl-Meyer flow relations.
- [NASA TR R-100, Stoney's free-flight drag collection](https://ntrs.nasa.gov/citations/19630004995): the desktop nose tables' source and afterbody validation data.
- [NACA Report 1307, Pitts, Nielsen and Kaattari](https://digital.library.unt.edu/ark:/67531/metadc65599/): slender wing/body interference and finite-wing CP lineage.
- [NASA TN D-6945, Hopkins, turbulent skin-friction charts](https://ntrs.nasa.gov/citations/19730001588): related Van Driest II work, not established provenance for the implemented .144/.65 fit.
- [OpenRocket technical documentation](https://openrocket.info/documentation.html): desktop model derivation; the app's optional corrections are described in this paper and the patch ledger.
