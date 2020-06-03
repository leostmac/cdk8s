import { TypeGenerator } from './type-generator';
import { ImportBase } from './base';
import { CodeMaker } from 'codemaker';
import { download } from '../util';
import * as yaml from 'yaml';
import { ImportSpec } from '../config';

const CRD_KIND = 'CustomResourceDefinition';

export interface ManifestObjectDefinition {
  apiVersion?: string;
  kind?: string;
  items?: ManifestObjectDefinition[]; // if `kind` is "List"
  metadata?: {
    name?: string;
  };
  spec?: {
    group: string;
    names: {
      kind: string;
      [key: string]: any;
    };
    versions?: Array<{
      name: string;
      schema?: { openAPIV3Schema?: any };
      [key: string]: any;
    }>;
    version?: string;
    validation?: { openAPIV3Schema?: any };
    [key: string]: any;
  };
}

// all these APIs are compatible from our perspective.
const SUPPORTED_API_VERSIONS = [
  'apiextensions.k8s.io/v1beta1',
  'apiextensions.k8s.io/v1'
];

export class CustomResourceDefinition {
  private readonly schema?: any;
  private readonly group: string;
  private readonly version: string;
  private readonly kind: string;
  private readonly fqn: string;

  constructor(manifest: ManifestObjectDefinition) {
    const apiVersion = manifest?.apiVersion ?? 'undefined';
    assert(SUPPORTED_API_VERSIONS.includes(apiVersion), `"apiVersion" is "${apiVersion}" but it should be one of: ${SUPPORTED_API_VERSIONS.map(x => `"${x}"`).join(', ')}`);
    assert(manifest.kind === CRD_KIND, `"kind" must be "${CRD_KIND}"`);

    const spec = manifest.spec;
    if (!spec) {
      throw new Error(`manifest does not have a "spec" attribute`)
    }

    const version = spec.version ?? (spec.versions ?? [])[0];
    if (!version) {
      throw new Error(`unable to determine CRD version`);
    }

    const schema = typeof version === 'string'
      ? spec.validation?.openAPIV3Schema
      : version?.schema?.openAPIV3Schema ?? spec.validation?.openAPIV3Schema;

    this.schema = schema;
    this.group = spec.group;
    this.version = typeof version === 'string' ? version : version.name;
    this.kind = spec.names.kind;
    this.fqn = this.kind;
  }

  public get moduleName() {
    return `${this.group}/${this.kind.toLocaleLowerCase()}`;
  }

  public async generateTypeScript(code: CodeMaker) {
    const types = new TypeGenerator();

    types.emitConstruct({
      group: this.group,
      version: this.version,
      kind: this.kind,
      fqn: this.fqn,
      schema: this.schema
    });

    code.line(`// generated by cdk8s`);
    code.line(`import { ApiObject } from 'cdk8s';`);
    code.line(`import { Construct } from 'constructs';`);
    code.line();
    types.generate(code);
  }
}

export class ImportCustomResourceDefinition extends ImportBase {
  public static async match(importSpec: ImportSpec): Promise<undefined | ManifestObjectDefinition[]> {
    const { source } = importSpec;
    const manifest = await download(source);
    return yaml.parseAllDocuments(manifest).map((doc: yaml.Document) => doc.toJSON());
  }

  private readonly defs: CustomResourceDefinition[] = [];

  constructor(manifest: ManifestObjectDefinition[]) {
    super();

    const defs: Record<string, CustomResourceDefinition> = { };

    const extractCRDs = (objects: ManifestObjectDefinition[] = []) => {
      for (const obj of objects) {
        // filter empty docs in the manifest
       if (!obj) {
         continue;
       }

       // found a crd, yey!
       if (obj.kind === CRD_KIND) {
          const crd = new CustomResourceDefinition(obj);
          const key = crd.moduleName;

          if (key in defs) {
            throw new Error(`${key} already exists`);
          }

          defs[key] = crd;
          continue;
       }

       // recurse into lists
       if (obj.kind === 'List') {
         extractCRDs(obj.items);
         continue;
       }
     }
    };

    extractCRDs(manifest);

    this.defs = Object.values(defs);
  }

  public get moduleNames() {
    return this.defs.map(crd => crd.moduleName);
  }

  protected async generateTypeScript(code: CodeMaker, moduleName: string) {
    this.defs.filter(crd => moduleName === crd.moduleName).map(crd => crd.generateTypeScript(code));
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`invalid CustomResourceDefinition manifest: ${message}`);
  }
}
