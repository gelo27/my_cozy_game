import React, { useState } from 'react';
import { 
  Box, 
  User, 
  Camera, 
  Sun, 
  Activity, 
  CircleDot,
  Layers
} from 'lucide-react';

export type PlaygroundZone = 'origin';

interface EntityHierarchyProps {
  onSelectZone: (zone: PlaygroundZone) => void;
  selectedEntity: string;
  setSelectedEntity: (name: string) => void;
  isGrounded?: boolean;
}

export const EntityHierarchy: React.FC<EntityHierarchyProps> = ({
  onSelectZone,
  selectedEntity,
  setSelectedEntity,
  isGrounded = true,
}) => {
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({
    root: true,
    env: true,
    player: true,
    camera: true,
    lighting: false,
  });

  const toggleNode = (node: string) => {
    setOpenNodes(prev => ({ ...prev, [node]: !prev[node] }));
  };

  const handleSelect = (name: string, zone?: PlaygroundZone) => {
    setSelectedEntity(name);
    if (zone) {
      onSelectZone(zone);
    }
  };

  return (
    <aside id="entity-hierarchy-panel" className="w-56 md:w-60 bg-[#121212] border-r border-[#222] flex flex-col shrink-0 select-none font-mono text-[11px] h-full overflow-hidden">
      {/* Panel Header */}
      <div className="px-3 py-2 bg-[#181818] text-[10px] font-bold border-b border-[#222] text-gray-400 flex items-center justify-between">
        <span className="tracking-wider flex items-center gap-1.5">
          <Layers className="w-3 h-3 text-blue-400" />
          ENTITY HIERARCHY (ECS)
        </span>
        <span className="text-[9px] text-gray-600">10 ENTITIES</span>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5 text-gray-300">
        {/* Scene Root */}
        <div 
          className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer ${
            selectedEntity === 'Scene_Root' ? 'bg-[#222] text-blue-400' : 'hover:bg-[#1a1a1a] text-blue-400'
          }`}
          onClick={() => { toggleNode('root'); setSelectedEntity('Scene_Root'); }}
        >
          <span className="opacity-70 text-[9px] w-3">
            {openNodes.root ? '▼' : '▶'}
          </span>
          <span className="font-semibold text-blue-400">Scene_Root</span>
        </div>

        {openNodes.root && (
          <div className="pl-3 border-l border-[#222] ml-2 space-y-0.5">
            {/* Environment Folder */}
            <div 
              className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer ${
                selectedEntity === 'Environment' ? 'bg-[#222] text-white' : 'hover:bg-[#1a1a1a] text-gray-300'
              }`}
              onClick={() => { toggleNode('env'); setSelectedEntity('Environment'); }}
            >
              <span className="opacity-70 text-[9px] w-3">
                {openNodes.env ? '▼' : '▶'}
              </span>
              <Box className="w-3 h-3 text-amber-400" />
              <span className="font-medium text-amber-300">Environment</span>
            </div>

            {openNodes.env && (
              <div className="pl-4 border-l border-[#222] ml-2 space-y-0.5 text-[10px]">
                <div 
                  onClick={() => handleSelect('Checker_Floor_01', 'origin')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                    selectedEntity === 'Checker_Floor_01' ? 'bg-blue-900/30 text-blue-300' : 'hover:bg-[#1a1a1a] text-gray-400'
                  }`}
                >
                  <span className="text-gray-600">◻</span>
                  <span>Arena_Floor_90x90m</span>
                </div>
              </div>
            )}

            {/* Player Entity */}
            <div 
              className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer ${
                selectedEntity === 'Player_Entity' ? 'bg-[#222] text-green-400' : 'hover:bg-[#1a1a1a] text-green-400'
              }`}
              onClick={() => { toggleNode('player'); setSelectedEntity('Player_Entity'); }}
            >
              <span className="opacity-70 text-[9px] w-3">
                {openNodes.player ? '▼' : '▶'}
              </span>
              <User className="w-3 h-3 text-green-400" />
              <span className="font-semibold text-green-400">Player_Entity</span>
            </div>

            {openNodes.player && (
              <div className="pl-4 border-l border-[#222] ml-2 space-y-0.5 text-[10px]">
                <div 
                  onClick={() => setSelectedEntity('RigidBody_Dynamic')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer ${
                    selectedEntity === 'RigidBody_Dynamic' ? 'bg-green-950/40 text-green-300' : 'hover:bg-[#1a1a1a] text-gray-400'
                  }`}
                >
                  <CircleDot className="w-2.5 h-2.5 text-green-500" />
                  <span>RigidBody_Dynamic</span>
                </div>

                <div 
                  onClick={() => setSelectedEntity('Capsule_Collider')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer ${
                    selectedEntity === 'Capsule_Collider' ? 'bg-green-950/40 text-green-300' : 'hover:bg-[#1a1a1a] text-gray-400'
                  }`}
                >
                  <span className="text-gray-500">◌</span>
                  <span>Collider_Capsule_1.5m</span>
                </div>

                <div 
                  onClick={() => setSelectedEntity('leanVisualEntity')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer ${
                    selectedEntity === 'leanVisualEntity' ? 'bg-cyan-950/40 text-cyan-300' : 'hover:bg-[#1a1a1a] text-cyan-400/90'
                  }`}
                >
                  <span className="text-cyan-400">❖</span>
                  <span>leanVisualEntity (Lean Effect)</span>
                </div>

                <div 
                  onClick={() => setSelectedEntity('Particle_Emitter_Dust')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer ${
                    selectedEntity === 'Particle_Emitter_Dust' ? 'bg-amber-950/40 text-amber-300' : 'hover:bg-[#1a1a1a] text-amber-400/90'
                  }`}
                >
                  <span className="text-amber-400">✦</span>
                  <span>Particle_Emitter_Dust</span>
                </div>

                <div 
                  onClick={() => setSelectedEntity('Mesh_White_Mannequin')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer ${
                    selectedEntity === 'Mesh_White_Mannequin' ? 'bg-green-950/40 text-green-300' : 'hover:bg-[#1a1a1a] text-gray-400'
                  }`}
                >
                  <span className="text-gray-300">◼</span>
                  <span>Mesh_White_Mannequin (1.5m)</span>
                </div>

                <div 
                  onClick={() => setSelectedEntity('Raycast_GroundDetector')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer ${
                    selectedEntity === 'Raycast_GroundDetector' ? 'bg-yellow-950/40 text-yellow-300' : 'hover:bg-[#1a1a1a] text-yellow-500/90 italic'
                  }`}
                >
                  <span className="text-yellow-400">↯</span>
                  <span>Raycast_GroundDetector</span>
                </div>

                <div 
                  onClick={() => setSelectedEntity('Locomotion_Abilities')}
                  className={`flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer ${
                    selectedEntity === 'Locomotion_Abilities' ? 'bg-blue-950/40 text-blue-300' : 'hover:bg-[#1a1a1a] text-blue-400'
                  }`}
                >
                  <Activity className="w-2.5 h-2.5 text-blue-400" />
                  <span>Abilities (Jump/Sprint/Dash)</span>
                </div>
              </div>
            )}

            {/* Camera */}
            <div 
              className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer ${
                selectedEntity === 'Main_Camera_3rdPerson' ? 'bg-[#222] text-purple-400' : 'hover:bg-[#1a1a1a] text-purple-400'
              }`}
              onClick={() => { toggleNode('camera'); setSelectedEntity('Main_Camera_3rdPerson'); }}
            >
              <span className="opacity-70 text-[9px] w-3">
                {openNodes.camera ? '▼' : '▶'}
              </span>
              <Camera className="w-3 h-3 text-purple-400" />
              <span className="font-medium text-purple-300">Camera_3rdPerson</span>
            </div>

            {openNodes.camera && (
              <div className="pl-4 border-l border-[#222] ml-2 space-y-0.5 text-[10px]">
                <div 
                  onClick={() => setSelectedEntity('Occlusion_Raycaster')}
                  className="flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer hover:bg-[#1a1a1a] text-gray-400"
                >
                  <span className="text-purple-400">◎</span>
                  <span>Occlusion_Raycaster</span>
                </div>
                <div 
                  onClick={() => setSelectedEntity('SpringArm_Damping')}
                  className="flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer hover:bg-[#1a1a1a] text-gray-400"
                >
                  <span className="text-gray-500">∼</span>
                  <span>SpringArm_Damping</span>
                </div>
              </div>
            )}

            {/* Lighting */}
            <div 
              className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer ${
                selectedEntity === 'Lighting' ? 'bg-[#222] text-yellow-400' : 'hover:bg-[#1a1a1a] text-gray-400'
              }`}
              onClick={() => { toggleNode('lighting'); setSelectedEntity('Lighting'); }}
            >
              <span className="opacity-70 text-[9px] w-3">
                {openNodes.lighting ? '▼' : '▶'}
              </span>
              <Sun className="w-3 h-3 text-yellow-500" />
              <span className="text-gray-400">Lighting_Rig</span>
            </div>
          </div>
        )}
      </div>

      {/* Selected Entity Mini-Card */}
      <div className="p-2.5 bg-[#0e0e0e] border-t border-[#222] text-[10px] space-y-1">
        <div className="text-gray-500 flex justify-between">
          <span>SELECTED:</span>
          <span className="text-blue-400 font-bold truncate max-w-[110px]">{selectedEntity}</span>
        </div>
        <div className="text-[9px] text-gray-500">
          Click any environment node to fast-teleport character.
        </div>
      </div>
    </aside>
  );
};
