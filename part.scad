dxf = "";
height = 2;
flip = true;

rotate([flip ? 180 : 0, 0, 0])
translate([0, 0, height * -1])
linear_extrude(height = height)
import(dxf);
