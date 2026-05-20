// Constraints + indexes
CREATE CONSTRAINT node_id_unique IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE;
CREATE INDEX node_type IF NOT EXISTS FOR (n:Node) ON (n.type);
CREATE INDEX node_name IF NOT EXISTS FOR (n:Node) ON (n.name);

// Nodes — TAB-separated (PrimeKG nodes.csv uses tabs after the build step strips quotes).
// file:/// resolves relative to Neo4j's import directory; the load wrapper symlinks
// data/kg/{nodes,edges}.csv into that directory.
LOAD CSV WITH HEADERS FROM 'file:///nodes.csv' AS row FIELDTERMINATOR '\t'
CALL {
  WITH row
  MERGE (n:Node {id: row.node_index})
  SET n.type = row.node_type,
      n.name = row.node_name,
      n.source = row.node_source
} IN TRANSACTIONS OF 5000 ROWS
FINISH;

// Edges — comma-separated; relationship type set per row from display_relation via APOC.
LOAD CSV WITH HEADERS FROM 'file:///edges.csv' AS row
CALL {
  WITH row
  MATCH (a:Node {id: row.x_index})
  MATCH (b:Node {id: row.y_index})
  CALL apoc.create.relationship(a, row.display_relation, {relation: row.relation}, b)
  YIELD rel
  RETURN rel
} IN TRANSACTIONS OF 5000 ROWS
FINISH;
