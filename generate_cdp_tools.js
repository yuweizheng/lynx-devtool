const fs = require('fs');
const path = require('path');

// Paths to protocol files
const browserProtocolPath = '/Users/zhengyuwei/Project/HDT_OSS/github_prj/lynx-devtool/node_modules/.pnpm/devtools-protocol@0.0.883894/node_modules/devtools-protocol/json/browser_protocol.json';
const jsProtocolPath = '/Users/zhengyuwei/Project/HDT_OSS/github_prj/lynx-devtool/node_modules/.pnpm/devtools-protocol@0.0.883894/node_modules/devtools-protocol/json/js_protocol.json';
const outputPath = 'plugins/lynx-ai-assistant/resources/cdp-tools.json';

// Manually defined Lynx protocol
const lynxProtocol = {
  domain: 'Lynx',
  description: 'Lynx specific domain.',
  commands: [
    {
      name: 'getComponentId',
      description: 'Get the component ID for a given node.',
      parameters: [
        { name: 'nodeId', type: 'integer', description: 'Id of the node to get component Id for.' }
      ],
      returns: [
        { name: 'componentId', type: 'string', description: 'Component Id.' }
      ]
    },
    {
      name: 'getProperties',
      description: 'Get properties of a Lynx node.',
      parameters: [
        { name: 'nodeId', type: 'integer', description: 'Id of the node.' }
      ],
      returns: [
        { name: 'properties', type: 'array', description: 'List of properties.' }
      ]
    },
    {
      name: 'getData',
      description: 'Get data associated with a Lynx node.',
      parameters: [
        { name: 'nodeId', type: 'integer', description: 'Id of the node.' }
      ],
      returns: [
        { name: 'data', type: 'object', description: 'Data object.' }
      ]
    },
    {
      name: 'setTraceMode',
      description: 'Set trace mode for Lynx.',
      parameters: [
        { name: 'mode', type: 'string', description: 'Trace mode.' }
      ]
    }
  ]
};

const typeMap = new Map();

function buildTypeMap(domains) {
  domains.forEach(domain => {
    if (domain.types) {
      domain.types.forEach(type => {
        typeMap.set(`${domain.domain}.${type.id}`, type);
        typeMap.set(type.id, type); // Also set without domain prefix for local refs (will be overwritten if collision, but local lookup handles it)
      });
    }
  });
}

function resolveType(domainName, ref) {
  if (!ref) return { type: 'string' }; // Default
  
  let typeKey = ref;
  if (!ref.includes('.')) {
    typeKey = `${domainName}.${ref}`;
  }
  
  const typeDef = typeMap.get(typeKey);
  if (!typeDef) {
    // Fallback: try without domain if not found (sometimes refs are global but without prefix in some contexts?)
    // Actually standard CDP refs are usually local or fully qualified.
    // If not found, guess based on name
    if (ref.endsWith('Id')) return { type: 'integer' };
    return { type: 'object' };
  }

  if (typeDef.type) {
    return { type: typeDef.type, enum: typeDef.enum };
  }
  
  return { type: 'object' }; // Complex types without explicit 'type' are usually objects
}

function convertToTool(domainName, command) {
  const toolName = `${domainName}_${command.name}`;
  const description = command.description || `Execute ${domainName}.${command.name}`;
  
  const properties = {};
  const required = [];

  if (command.parameters) {
    command.parameters.forEach(param => {
      let paramSchema = {
        description: param.description
      };

      if (param.type) {
        paramSchema.type = param.type;
      } else if (param.$ref) {
        const resolved = resolveType(domainName, param.$ref);
        paramSchema.type = resolved.type;
        if (resolved.enum) {
          paramSchema.enum = resolved.enum;
        }
      } else {
        paramSchema.type = 'string'; // Fallback
      }

      // Fix types for JSON schema compatibility
      if (paramSchema.type === 'any') paramSchema.type = 'object'; // 'any' is not standard JSON schema, usually mapped to object or {}

      properties[param.name] = paramSchema;

      if (!param.optional) {
        required.push(param.name);
      }
    });
  }

  return {
    name: toolName,
    description: description,
    input_schema: {
      type: 'object',
      properties: properties,
      required: required
    }
  };
}

function main() {
  let browserProtocol, jsProtocol;
  try {
    browserProtocol = JSON.parse(fs.readFileSync(browserProtocolPath, 'utf8'));
    jsProtocol = JSON.parse(fs.readFileSync(jsProtocolPath, 'utf8'));
  } catch (e) {
    console.error('Failed to read protocol files:', e);
    process.exit(1);
  }

  const domains = [
    ...browserProtocol.domains,
    ...jsProtocol.domains,
    lynxProtocol
  ];

  buildTypeMap(domains);

  const tools = [];
  // Filter for important domains
  const domainFilter = ['DOM', 'CSS', 'Page', 'Overlay', 'Log', 'Runtime', 'Lynx', 'Input', 'Emulation', 'Network', 'Target'];

  domains.forEach(domain => {
    if (!domainFilter.includes(domain.domain)) return;

    if (domain.commands) {
      domain.commands.forEach(command => {
        tools.push(convertToTool(domain.domain, command));
      });
    }
  });

  fs.writeFileSync(outputPath, JSON.stringify(tools, null, 2));
  console.log(`Generated ${tools.length} tools to ${outputPath}`);
}

main();
