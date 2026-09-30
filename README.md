# General Info
[Link to Onshape](https://cad.onshape.com/documents/d8dc7a13f6a9b5ffd7271f29/v/bca2c2decaa62b8807801ea4/e/7e72cf8fe64cf86df6e6870c)

This repository contains all of the code for openrocket-onshape, an easy two step process to bring rockets designed and simulated in Openrocket into Onshape. This allows an Onshape model to be a fully defined source of truth for building a rocket, which can alleviate difficulties with integration and internal systems. 
Additionally, the Onshape-native geometry allows easy modification of parts this feature generates.

The workflow includes a public webapp that converts the OpenRocket file into a .json file, and an Onshape custom feature that generates geometry and parts based on the uploaded .json file. Once the parts are generated, an assembly can be created by inserting the **composite parts** from the part studio and fastening together the generated mate connectors.

The current workflows for getting rockets into CAD are either time intensive or impractical which is why this project was started. The most common is remodeling the rocket in CAD which takes time and could result in errors. The second is exporting from OpenRocket as .obj, which produces geometry that is difficult to modify in CAD. Another converts into OpenSCAD which can be difficult to modify later and doesn't support all openrocket components.


If you notice any issues or have any recommendations, please create an issue here.


# Development Notes
Initially, most the featurescript code and functionality was handwritten. 

The webapp was written completely using some cheap models on Openrouter (and the one mentioned below) as it is mostly converting from xml to json. However, the LLMs did decide how to create profiles (by sampling), which works well. 

A free stealth model became available on Openrouter, it has been used to implement a few tricky components like fins and podsets. The model can write featurescript well but just requires more thought, a decent skill file, and some occasional help. Over a billion tokens with this model.