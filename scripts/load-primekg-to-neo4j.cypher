// Constraints + indexes
CREATE CONSTRAINT node_id_unique IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE;
CREATE INDEX node_type IF NOT EXISTS FOR (n:Node) ON (n.type);
CREATE INDEX node_name IF NOT EXISTS FOR (n:Node) ON (n.name);

// Nodes — adjust column names if PrimeKG schema differs
:auto LOAD CSV WITH HEADERS FROM 'file:///data/kg/nodes.csv' AS row
CALL {
  WITH row
  MERGE (n:Node {id: row.node_index})
  SET n.type = row.node_type,
      n.name = row.node_name,
      n.source = row.node_source
} IN TRANSACTIONS OF 5000 ROWS;

// Edges — relationship type set per row from display_relation
:auto LOAD CSV WITH HEADERS FROM 'file:///data/kg/edges.csv' AS row
CALL {
  WITH row
  MATCH (a:Node {id: row.x_index})
  MATCH (b:Node {id: row.y_index})
  CALL apoc.create.relationship(a, row.display_relation, {relation: row.relation}, b)
  YIELD rel
  RETURN rel
} IN TRANSACTIONS OF 5000 ROWS;
